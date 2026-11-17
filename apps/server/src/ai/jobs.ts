/**
 * F§9's summary jobs: the state of a summary, the queue that writes one, and the recovery of a job a restart
 * cut short.
 *
 * A job is *state in a table*, not a promise in memory. F§8.4's `summaries` row is what a client polls and what
 * survives a restart, and this module is the only writer of it:
 *
 * - **`request`** answers from the row when the row is what was asked for — a finished result whose model and
 *   prompt version are the current ones is the cache F§9 describes, keyed by `(docId, mode, model,
 *   promptVersion)` — and otherwise enqueues the work and answers `running`.
 * - **One job at a time** (F§9, and the contract's *Forbidden Actions*): a request that arrives while another
 *   is running is queued behind it, so a hub with one model endpoint never has two summaries competing for it.
 * - **`recoverInterrupted`** runs once at start-up and turns every `running` row into an `error` with
 *   `INTERRUPTED`, because a row that says `running` after a restart describes a job no process is doing.
 *
 * The document's own bytes are read here, when the job runs, rather than handed in by the route: a request
 * arrives with an identifier, and the model may have been stored by an earlier request, by a sync round or by
 * the same request's inline document. A model that cannot be read is recorded as `MODEL_MISSING` — the code the
 * AI set already has for "the hub has nothing to summarize" — and the job ends there.
 *
 * A job never throws: every failure it can have is a row it writes, which is what makes `request` safe to
 * answer `running` from before any of the work has happened.
 */

import {
  type AiErrorCode,
  MAX_MODEL_UPLOAD_BYTES,
  SummaryErrorSchema,
  type SummaryMode,
  type SummaryResult,
  SummaryResultSchema,
  type SummaryStatus,
} from "@lectern/api-contract";
import { type DocumentModel, DocumentModelSchema } from "@lectern/core";
import { z } from "zod";
import type { HubDatabase } from "../db/database";
import type { DocumentFiles } from "../db/document-files";
import { describeIssues, messageOf } from "../errors";
import { PROMPT_VERSION } from "./prompts";
import { LlmError, type LlmProvider } from "./provider";
import { LlmInvalidOutputError, summarize } from "./summarize";

/** F§8.4's summary row for one document and mode: the state, and what a finished state was written with. */
const SELECT_ROW = "SELECT status, model, prompt_version, json FROM summaries WHERE doc_id = ? AND mode = ?";

/**
 * F§8.4's row written whole. The upsert is what makes the row's own primary key `(doc_id, mode)` the identity
 * of a summary: a second request for the same document and mode replaces that row rather than adding one.
 */
const UPSERT_ROW =
  "INSERT INTO summaries (doc_id, mode, model, prompt_version, status, json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT (doc_id, mode) DO UPDATE SET model = excluded.model, prompt_version = excluded.prompt_version, status = excluded.status, json = excluded.json, updated_at = excluded.updated_at";

/** F§9's recovery: a row that says `running` when nothing is running is an interrupted job, not a live one. */
const MARK_INTERRUPTED = "UPDATE summaries SET status = 'error', json = ?, updated_at = ? WHERE status = 'running'";

/** The sentence a recovered row carries, so a client is told what happened to its job rather than only a code. */
const INTERRUPTED_MESSAGE = "this summary was interrupted by a restart of the hub (F§9)";

/** What F§8.4's row looks like as this module reads it: a status, and the two provenance columns beside it. */
const RowSchema = z.object({
  status: z.enum(["running", "done", "error"]),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  json: z.string().nullable(),
});
type Row = z.infer<typeof RowSchema>;

/** The subset of the host's `node:zlib` this module uses, reached by a specifier when a model is read. */
interface HostZlib {
  gunzipSync(buffer: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
}

/** The host's zlib, reached through a `string`-typed specifier so this package's program keeps no Node ambient types. */
async function hostZlib(): Promise<HostZlib> {
  const specifier: string = "node:zlib";
  return (await import(specifier)) as HostZlib;
}

/** A failure a job records under a code of its own (F§9). */
class JobFailure extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = "JobFailure";
    this.code = code;
  }
}

/** The F§9 code a failed job is recorded under: what the failure named, or the provider's own code. */
function failureCode(cause: unknown): AiErrorCode {
  if (cause instanceof JobFailure || cause instanceof LlmInvalidOutputError || cause instanceof LlmError) return cause.code;
  return "LLM_UNAVAILABLE";
}

/** A JSON column read back as a value, or `null` when the text is not JSON at all. */
function readJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** What a caller must give the jobs (F§9, F§8.4): the storage, the provider, the model and the clock. */
export interface SummaryJobsOptions {
  /** F§8.4's database file, where F§9's state lives. */
  db: HubDatabase;
  /** F§8.4's document files, where the model a job summarizes is kept. */
  files: DocumentFiles;
  /** F§9's provider. A hub with none has no AI routes at all, so there is always one here. */
  provider: LlmProvider;
  /** The configured model (F§7.1). It is half of F§9's cache key and is recorded in every result. */
  model: string;
  /** The clock a row's `updated_at` and a result's `createdAt` are stamped with. */
  now: () => number;
}

/** F§9's summary jobs, as the routes use them. */
export interface SummaryJobs {
  /** Ask for a summary: the cached result, the state of a job already running, or a new job answered `running`. */
  request(docId: string, mode: SummaryMode): SummaryStatus;
  /** What the hub holds for one document and mode, without asking for anything. */
  status(docId: string, mode: SummaryMode): SummaryStatus;
  /** Mark every `running` row as `error` `INTERRUPTED` (F§9), and answer how many rows that was. */
  recoverInterrupted(): number;
}

/**
 * `createSummaryJobs({ db, files, provider, model, now })` — F§9's summarization pipeline over one hub.
 *
 * The queue is this closure's own state: `pending` holds the documents waiting for the one model slot and
 * `running` says whether the slot is taken. A job is started the moment it is enqueued when the slot is free,
 * and the pump drains the queue in order, so two documents requested together are summarized one after the
 * other rather than side by side.
 */
export function createSummaryJobs(options: SummaryJobsOptions): SummaryJobs {
  const { db, files, provider, model, now } = options;
  const pending: { docId: string; mode: SummaryMode }[] = [];
  let running = false;

  /** One row written whole. F§8.4's two provenance columns are filled only for a finished result. */
  function writeRow(docId: string, mode: SummaryMode, status: Row["status"], json: string | null, recorded: boolean): void {
    db.prepare(UPSERT_ROW).run(docId, mode, recorded ? model : null, recorded ? PROMPT_VERSION : null, status, json, now());
  }

  /** The stored row for one document and mode, or `null` when there is none this module can read. */
  function readRow(docId: string, mode: SummaryMode): Row | null {
    const parsed = RowSchema.safeParse(db.prepare(SELECT_ROW).get(docId, mode));
    return parsed.success ? parsed.data : null;
  }

  /** The stored row as the contract's status: `none` with no row, the result when done, the failure when not. */
  function statusOf(row: Row | null, mode: SummaryMode): SummaryStatus {
    if (row === null) return { status: "none" };
    if (row.status === "running") return { status: "running" };
    const stored = readJson(row.json);
    if (row.status === "done") {
      const result = SummaryResultSchema(mode).safeParse(stored);
      if (result.success) return { status: "done", result: result.data };
      return { status: "error", error: { code: "LLM_INVALID_OUTPUT", message: "the stored summary is not a valid result (F§9)" } };
    }
    const failure = SummaryErrorSchema.safeParse(stored);
    if (failure.success) return { status: "error", error: failure.data };
    return { status: "error", error: { code: "INTERRUPTED", message: INTERRUPTED_MESSAGE } };
  }

  /** The model a job summarizes, read back out of F§8.4's document files and validated as F§5.1's document. */
  async function readModel(docId: string): Promise<DocumentModel> {
    const bytes = await files.getModel(docId);
    if (bytes === null) throw new JobFailure("MODEL_MISSING", `this hub holds no model for the document ${docId} (F§8.4)`);

    let inflated: Uint8Array;
    try {
      const zlib = await hostZlib();
      inflated = zlib.gunzipSync(bytes, { maxOutputLength: MAX_MODEL_UPLOAD_BYTES });
    } catch (cause) {
      throw new JobFailure("MODEL_MISSING", `the model of ${docId} could not be read — ${messageOf(cause)}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(inflated)) as unknown;
    } catch (cause) {
      throw new JobFailure("MODEL_MISSING", `the model of ${docId} is not JSON — ${messageOf(cause)}`);
    }

    const parsed = DocumentModelSchema.safeParse(value);
    if (!parsed.success) throw new JobFailure("MODEL_MISSING", `the model of ${docId} is not a document — ${describeIssues(parsed.error)}`);
    return parsed.data;
  }

  /** One job, from the model's bytes to the row it leaves behind. It never throws: a failure is a row too. */
  async function runOne(job: { docId: string; mode: SummaryMode }): Promise<void> {
    let document: DocumentModel;
    try {
      document = await readModel(job.docId);
    } catch (cause) {
      writeRow(job.docId, job.mode, "error", JSON.stringify({ code: failureCode(cause), message: messageOf(cause) }), false);
      return;
    }

    try {
      const result: SummaryResult = await summarize(provider, document, job.mode, { model, now });
      writeRow(job.docId, job.mode, "done", JSON.stringify(result), true);
    } catch (cause) {
      writeRow(job.docId, job.mode, "error", JSON.stringify({ code: failureCode(cause), message: messageOf(cause) }), false);
    }
  }

  /**
   * Drain the queue, one job at a time, until nothing is left.
   *
   * A job's only channel is the row it writes, and the promise this loop runs on is nobody's to await — the
   * route answered `running` before any of the work started. A failure that escapes a job is therefore dropped
   * rather than left as an unhandled rejection: the one it can still meet is a row that cannot be written
   * because the hub is closing, and there is nothing left for the job to report to.
   */
  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const job = pending.shift();
        if (job === undefined) break;
        try {
          await runOne(job);
        } catch {
          // Nothing left to write it to: see above.
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    request: (docId: string, mode: SummaryMode): SummaryStatus => {
      const row = readRow(docId, mode);
      if (row !== null && row.status === "running") return { status: "running" };
      if (row !== null && row.status === "done" && row.model === model && row.prompt_version === PROMPT_VERSION) {
        const cached = statusOf(row, mode);
        if (cached.status === "done") return cached;
      }
      writeRow(docId, mode, "running", null, false);
      pending.push({ docId, mode });
      void pump();
      return { status: "running" };
    },

    status: (docId: string, mode: SummaryMode): SummaryStatus => statusOf(readRow(docId, mode), mode),

    recoverInterrupted: (): number => {
      const written = db.prepare(MARK_INTERRUPTED).run(JSON.stringify({ code: "INTERRUPTED", message: INTERRUPTED_MESSAGE }), now());
      const changes = (written as { changes?: unknown } | null)?.changes;
      return typeof changes === "number" ? changes : 0;
    },
  };
}
