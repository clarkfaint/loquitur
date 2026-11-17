/**
 * F§9's summarization: one document in, one validated `SummaryResult` out, over the map-reduce the section
 * describes.
 *
 * The shape of the work:
 *
 * - The document's non-skipped text is segmented (F§9's 12 000-character ceiling, `./segment`).
 * - **Map:** every segment is sent on its own and answered with up to eight notes.
 * - **Reduce:** the notes are sent once and answered with the summary and its key takeaways.
 * - A document that fits in **one** segment skips the map step entirely: there is nothing to condense, so its
 *   own text is the reduce step's material and the document costs one model call rather than two.
 *
 * Every reply is read as JSON and validated before it is used for anything, and a reply that does not validate
 * is not thrown away — F§9's rule is that the *validation error* is appended to the user message and the call
 * is made again, up to two retries. A model that answers prose once usually answers the object the second time
 * when it is told what was wrong with the first; a model that never does is `LLM_INVALID_OUTPUT` after the
 * third attempt, which is a state the job records rather than a crash.
 *
 * Two things the result carries are not the model's to answer: which model wrote it and when. F§9 caches a
 * summary by `(docId, mode, LLM_MODEL, promptVersion)`, so both are supplied by the caller — the pipeline that
 * owns the configured model and the clock (`./jobs`) — rather than invented here. `PROMPT_VERSION` is this
 * file's own prompt version (`./prompts`).
 *
 * Nothing in this module knows about routes, storage or scheduling: it is a pure function of a provider, a
 * document and a mode, which is what makes it testable against the mock endpoint with no hub at all.
 */

import { type AiErrorCode, SUMMARY_LIMITS, type SummaryMode, type SummaryResult, SummaryResultSchema } from "@lectern/api-contract";
import type { DocumentModel } from "@lectern/core";
import { z } from "zod";
import { describeIssues, messageOf } from "../errors";
import { MAP_NOTES, mapSystemMessage, mapUserMessage, PROMPT_VERSION, reduceSystemMessage, reduceUserMessage } from "./prompts";
import type { LlmProvider } from "./provider";
import { segmentDocument } from "./segment";

/** F§9's retry budget: the first call and the two retries its validation rule allows. */
export const MAX_ATTEMPTS = 3;

/** How much the map step may write back. F§9 names no ceiling; eight short notes fit well inside this. */
const MAP_MAX_TOKENS = 512;

/** How much the reduce step may write back. F§9's loosest result ceiling is 4 000 characters. */
const REDUCE_MAX_TOKENS = 2048;

/** What the retry's user message says before the validation error it carries (F§9). */
const RETRY_LABEL = "Your previous reply was rejected:";

/** F§9's one failure from this module, tied to the contract's closed AI code set at compile time. */
const LLM_INVALID_OUTPUT = "LLM_INVALID_OUTPUT" satisfies AiErrorCode;

/** The code every refusal from this module carries (F§9). */
export type SummaryErrorCode = typeof LLM_INVALID_OUTPUT;

/**
 * The one failure this module raises (F§9): the model answered, three times, something that is not the object
 * the mode's result requires. A job records this as the document's state rather than retrying for ever, and the
 * message carries the last validation error so an operator can see what the model kept getting wrong.
 */
export class LlmInvalidOutputError extends Error {
  readonly code: SummaryErrorCode = LLM_INVALID_OUTPUT;

  constructor(message: string) {
    super(message);
    this.name = "LlmInvalidOutputError";
  }
}

/**
 * What a caller must supply beside the provider, the document and the mode: the two facts of the result the
 * model cannot answer for itself. Both are injected rather than read from a global, so a case needs no wall
 * clock and no configured model (AGENTS.md §7).
 */
export interface SummarizeOptions {
  /** The model that wrote the summary. F§9 records it in the result and caches by it. */
  model: string;
  /** The clock the result's `createdAt` is stamped with. */
  now: () => number;
}

/** F§9's map answer: the notes one segment yielded. */
const MapReplySchema = z.strictObject({ notes: z.array(z.string().min(1)).max(MAP_NOTES) });

/** What the reduce step must answer with: F§9's two fields, before the result's own provenance is added. */
interface SummaryDraft {
  summary: string;
  keyTakeaways: string[];
}

/**
 * The reduce step's answer schema for one mode (F§9): the summary and its takeaways under *that mode's*
 * ceilings — the loosest a reply may be before the hub calls it invalid, taken from the contract rather than
 * written out again here, so the hub and a client cannot disagree about what a valid result is.
 *
 * The schema is deliberately looser than the prompt (F§9), so a reply that overshoots what was asked for by a
 * little is still a usable summary. What it is *not* looser than is the mode: a `brief` reply with seven
 * takeaways is not a long `brief`, it is a reply to validate again.
 */
function reduceReplySchema(mode: SummaryMode): z.ZodType<SummaryDraft> {
  const limits = SUMMARY_LIMITS[mode];
  return z.strictObject({
    summary: z.string().min(1).max(limits.summaryChars),
    keyTakeaways: z.array(z.string().min(1)).min(limits.minTakeaways).max(limits.maxTakeaways),
  });
}

/** A reply read and validated, or the one line that says why it is not usable (F§9's retry text). */
type ReadReply<T> = { value: T } | { error: string };

/**
 * A reader for one schema: the model's text as JSON, then the schema's own verdict on it.
 *
 * A reply that is not JSON and a reply that is JSON of the wrong shape are the same thing to the caller — an
 * answer that cannot be used — so both come back as one line, and that line is what the retry appends to the
 * user message.
 */
function validating<T>(schema: z.ZodType<T>): (reply: string) => ReadReply<T> {
  return (reply: string): ReadReply<T> => {
    let value: unknown;
    try {
      value = JSON.parse(reply) as unknown;
    } catch (cause) {
      return { error: `the reply is not JSON — ${messageOf(cause)}` };
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? { value: parsed.data } : { error: describeIssues(parsed.error) };
  };
}

/**
 * One call, with F§9's retries: ask, read, and — when the reply does not validate — ask again with the
 * validation error appended to the same user message.
 *
 * The retry message is always the original user message plus the latest error, rather than the growing chain a
 * retry that appended to *its own* message would produce: three attempts then cost three messages of a known
 * size, and the model sees one problem at a time.
 */
async function ask<T>(
  provider: LlmProvider,
  system: string,
  user: string,
  read: (reply: string) => ReadReply<T>,
  maxTokens: number,
): Promise<T> {
  let prompt = user;
  let lastError = "the model answered nothing usable";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reply = await provider.complete({ system, user: prompt, json: true, maxTokens });
    const result = read(reply);
    if ("value" in result) return result.value;
    lastError = result.error;
    prompt = `${user}\n\n${RETRY_LABEL} ${result.error}`;
  }
  throw new LlmInvalidOutputError(`the model's answer never validated in ${MAX_ATTEMPTS} attempts — ${lastError}`);
}

/**
 * The map step over every segment (F§9): each segment on its own, its notes appended in document order, so the
 * reduce step reads the document in the order it was written. The calls are sequential — a summary job holds the
 * one model slot this hub has (F§9's "one job at a time") — and each one carries its own retry budget.
 */
async function mapNotes(provider: LlmProvider, segments: readonly string[]): Promise<string[]> {
  const read = validating(MapReplySchema);
  const notes: string[] = [];
  for (const segment of segments) {
    const reply = await ask(provider, mapSystemMessage(), mapUserMessage(segment), read, MAP_MAX_TOKENS);
    notes.push(...reply.notes);
  }
  return notes;
}

/**
 * `summarize(provider, doc, mode, options)` — F§9's map-reduce for one document.
 *
 * A document of one segment (or none) skips the map step and sends its own text as the reduce material; a
 * longer one maps first and reduces the notes. The reduce step's reply is validated against the mode's own
 * limits, and the finished result — the reply plus the model, the prompt version and the clock reading — is
 * validated against the contract's `SummaryResultSchema` before it is returned, so nothing this module hands
 * back can fail a client's own check of it.
 *
 * A provider that cannot answer at all (`LLM_UNAVAILABLE`) is thrown as it arrives: the job that called this
 * records it as the document's failure, and it is not something a retry with a validation error would fix.
 */
export async function summarize(
  provider: LlmProvider,
  doc: DocumentModel,
  mode: SummaryMode,
  options: SummarizeOptions,
): Promise<SummaryResult> {
  const segments = segmentDocument(doc);
  const material = segments.length > 1 ? await mapNotes(provider, segments) : segments;

  const draft = await ask(
    provider,
    reduceSystemMessage(mode),
    reduceUserMessage(mode, material),
    validating(reduceReplySchema(mode)),
    REDUCE_MAX_TOKENS,
  );
  const result = SummaryResultSchema(mode).safeParse({
    summary: draft.summary,
    keyTakeaways: draft.keyTakeaways,
    model: options.model,
    promptVersion: PROMPT_VERSION,
    createdAt: options.now(),
  });
  if (!result.success) throw new LlmInvalidOutputError(`the finished summary is not a valid result — ${describeIssues(result.error)}`);
  return result.data;
}
