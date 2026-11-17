/**
 * The hub's LLM boundary (F§9): the one provider interface every AI feature is written against, and the
 * adapter for an OpenAI-compatible `/chat/completions` endpoint.
 *
 * There is no LLM SDK here — one `POST` over the host's `fetch` is the whole integration — and nothing but
 * the two prompt messages ever leaves the hub: no document identifier, no token, no metadata. The endpoint,
 * the model and the key all arrive from configuration (F§7.1), so this file names no address and no model,
 * and neither a prompt nor a completion is ever logged.
 */

import type { AiErrorCode } from "@lectern/api-contract";
import { z } from "zod";

/** The one path this adapter calls (F§9), appended to the configured base URL. */
const COMPLETIONS_PATH = "/chat/completions";

/** The content type of the request and of the answer the mock and a real endpoint both send. */
const CONTENT_TYPE = "application/json";

/**
 * How long a model has to answer before the adapter gives up on it. F§9 names no deadline, and a summary is
 * a far slower call than a chunk of speech, so this sits well above the engines' own 30 s.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** F§9's sampling temperature, fixed: a summary must not wander between two runs of the same document. */
const TEMPERATURE = 0.2;

/** F§9's AI code every refusal from this adapter carries, tied to the contract's closed set at compile time. */
const LLM_UNAVAILABLE = "LLM_UNAVAILABLE" satisfies AiErrorCode;

/** The one code this adapter reports (F§9): the endpoint could not be reached, or answered nothing usable. */
export type LlmErrorCode = typeof LLM_UNAVAILABLE;

/**
 * F§9's completion request: the two prompt messages, whether the answer must be a JSON object, and the
 * ceiling on how much the model may write. Its shape is F§9's own inline parameter, named so a caller, a
 * route and a test can all refer to one type rather than repeating it.
 */
export interface LlmCompletionRequest {
  system: string;
  user: string;
  json: boolean;
  maxTokens: number;
}

/** F§9's provider boundary: one completion, answered with the model's own text and nothing else. */
export interface LlmProvider {
  complete(req: LlmCompletionRequest): Promise<string>;
}

/**
 * The one failure this adapter reports (F§9). `code` is what a summary's stored state is written with, so a
 * provider that is down is a recognizable state rather than a bare string.
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

/**
 * What this adapter needs of a request: the method, the headers it carries, a JSON body, and a signal a real
 * transport can abandon the socket with. It is narrower than a `RequestInit`, which is what lets a host pass
 * its own `fetch` and a test its own stub.
 */
export interface LlmRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
}

/** What this adapter needs of an answer: whether it succeeded, its status, and its body as JSON. */
export interface LlmAnswer {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** The transport this adapter speaks over (F§9): the host's `fetch`, or one an operator injects. */
export type LlmFetch = (url: string, request: LlmRequest) => Promise<LlmAnswer>;

/** What an operator configures the adapter with (F§7.1, F§9): the endpoint, the model, and the key if it needs one. */
export interface OpenAiCompatibleProviderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: LlmFetch;
  timeoutMs?: number;
}

/**
 * An OpenAI-compatible answer, as far as this adapter reads it: a list of choices, the first of which carries
 * the model's own text. Unknown fields are stripped rather than refused, because every server adds its own
 * usage counters and identifiers beside the ones this hub asked for.
 */
const CompletionAnswerSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

/** A caught value's message, for this adapter's own refusals. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The host's `fetch`, or `null` when this host has none: the global is not declared for this package. */
function hostFetch(): LlmFetch | null {
  const candidate: unknown = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as LlmFetch) : null;
}

/**
 * F§9's request body: the configured model, the two prompt messages, the token ceiling, the fixed
 * temperature, and `response_format` — the one key that is present only when the caller asked for JSON.
 */
function requestBody(model: string, req: LlmCompletionRequest): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    max_tokens: req.maxTokens,
    temperature: TEMPERATURE,
    ...(req.json ? { response_format: { type: "json_object" } } : {}),
  });
}

/** The headers F§9's request carries: always the content type, and a bearer key only when one is configured. */
function requestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": CONTENT_TYPE,
    ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
  };
}

/**
 * `createOpenAiCompatibleProvider({ baseUrl, model, apiKey?, fetch?, timeoutMs? })` — F§9's one adapter.
 *
 * One `POST` to `{baseUrl}/chat/completions` carries F§9's fields and nothing else; the answer's first choice
 * is the model's text. Every way the call can fail — an unreachable endpoint, an HTTP error, an answer that
 * cannot be read, an empty choice list, and the deadline passing — is the one `LLM_UNAVAILABLE` refusal, so a
 * caller has a single failure to handle and a state to record.
 *
 * The signal is passed to the transport, so a real `fetch` abandons the socket at the deadline; the race is
 * what makes the deadline hold for a transport that ignores the signal. The abandoned request is caught here,
 * because nothing is waiting for it once the deadline has answered.
 */
export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions): LlmProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const injected = options.fetch;
  const url = `${baseUrl}${COMPLETIONS_PATH}`;

  return {
    complete: async (req: LlmCompletionRequest): Promise<string> => {
      const transport = injected ?? hostFetch();
      if (transport === null) throw new LlmError(LLM_UNAVAILABLE, `${url} is unreachable: this host has no fetch`);

      const controller = new AbortController();
      let timer: number | null = null;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      });

      const pending = transport(url, {
        method: "POST",
        headers: requestHeaders(options.apiKey),
        body: requestBody(options.model, req),
        signal: controller.signal,
      });
      pending.catch(() => undefined);

      try {
        const answer = await Promise.race([pending, deadline]);
        if (answer === null) throw new LlmError(LLM_UNAVAILABLE, `${url} did not answer within ${timeoutMs} ms`);
        if (!answer.ok) throw new LlmError(LLM_UNAVAILABLE, `${url} answered HTTP ${answer.status}`);
        const parsed = CompletionAnswerSchema.safeParse(await answer.json());
        if (!parsed.success) throw new LlmError(LLM_UNAVAILABLE, `${url} answered no readable completion`);
        const choice = parsed.data.choices[0];
        if (choice === undefined) throw new LlmError(LLM_UNAVAILABLE, `${url} answered no completion choices`);
        return choice.message.content;
      } catch (cause) {
        if (cause instanceof LlmError) throw cause;
        throw new LlmError(LLM_UNAVAILABLE, `${url} could not be read: ${messageOf(cause)}`);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
  };
}
