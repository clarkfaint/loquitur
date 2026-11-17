/**
 * The AI client (F§7.2, F§9): asking for a document's summary, reading the state of the job that writes it,
 * and waiting for that job to finish.
 *
 * It is built the way U-021's hub client and U-058's sync client are: the origin, the token and the transport
 * arrive as arguments, so the same code serves the web app, the extension, the desktop app and a test, and no
 * global `fetch` appears anywhere in this package. The token travels in the `Authorization` header of every
 * call and never in a URL (F§11).
 *
 * **A summary is a job, not a reply.** `POST /v1/ai/summary` answers `202` with the job's state — `running` the
 * first time, the cached result when F§9's cache key already holds one — and a result is read back from
 * `GET /v1/ai/summary/:docId?mode=`. `waitForSummary` is that second call on a schedule: the hub is asked one,
 * two and three seconds after the request and every five seconds after that, and never for longer than ten
 * minutes (F§9). Every wait is driven by an injected clock, so a test pins the whole schedule without waiting
 * for it.
 *
 * **The AI code set is not F§7.2's shared one**, so a refusal here is this module's own `AiClientError`, whose
 * code is a member of either set: `AI_DISABLED` when the hub has no LLM endpoint configured (F§7.1),
 * `MODEL_MISSING` when it holds no model for the document, and F§7.2's own codes — `UNAUTHORIZED`,
 * `ENGINE_UNAVAILABLE` — for everything the shared envelope answers with. Reading an AI code as `INTERNAL` with
 * the hub's code quoted in the message (which is what the sync client does with F§8.2's two codes) would hide
 * exactly the distinction a screen acts on.
 */

import {
  type AiErrorCode,
  AiErrorCodeSchema,
  ErrorBodySchema,
  type ErrorCode,
  ErrorCodeSchema,
  SummaryErrorSchema,
  type SummaryMode,
  SummaryRequestSchema,
  type SummaryStatus,
  SummaryStatusSchema,
} from "@lectern/api-contract";
import type { Clock, DocumentModel } from "@lectern/core";
import { z } from "zod";

/** What an AI call can fail with: F§7.2's shared set and F§9's AI set, which are two closed sets. */
export type AiClientErrorCode = ErrorCode | AiErrorCode;

/** What an `AiClientError` is built from. `offline` is false for every answer a hub actually sent. */
export interface AiClientErrorInit {
  code: AiClientErrorCode;
  /** The HTTP status, or `0` when no exchange happened. */
  status: number;
  message: string;
  offline?: boolean;
}

/**
 * One failed AI call (F§7.2, F§9).
 *
 * `code` is the code the hub put in its envelope — F§7.2's shared set, or F§9's own when the refusal is one
 * only the AI routes can answer — or the code this client assigns when the failure is its own: a transport that
 * rejected the request, a body that is not the shape the contract defines, or a request this client refuses to
 * send. `status` is `0` when there is no HTTP answer to report, and `offline` is true only for the transport
 * failure.
 */
export class AiClientError extends Error {
  readonly code: AiClientErrorCode;
  readonly status: number;
  readonly offline: boolean;

  constructor(init: AiClientErrorInit) {
    super(init.message);
    this.name = "AiClientError";
    this.code = init.code;
    this.status = init.status;
    this.offline = init.offline ?? false;
  }
}

/** What a client is built from: the hub's address, the shared token, and the transport that reaches it. */
export interface AiClientOptions {
  /** The hub's origin, for example `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** F§11's single pre-shared bearer token. */
  token: string;
  /** The transport. Injected, so the client is isomorphic and a test drives it without a socket. */
  fetch: typeof fetch;
}

/** How a wait is driven: the clock it polls on, the signal that abandons it, and who is told each state. */
export interface WaitForSummaryOptions {
  /** Every timer and timestamp the wait reads (F§5.7's injection rule). */
  clock: Clock;
  /** Abandon the wait: the promise rejects with an `AbortError` and no further poll happens. */
  signal?: AbortSignal;
  /** Told every state the hub answers with, which is what a screen draws while it waits. */
  onStatus?: (status: SummaryStatus) => void;
}

/** The hub's AI routes (F§7.2), as one typed client. */
export interface AiClient {
  /**
   * `POST /v1/ai/summary` — ask for a summary, and answer the job's state: `running` for a job this request
   * started, the cached result when F§9's cache key already holds one.
   *
   * A `document` is the document's own model. It is sent when the caller holds one and the hub may not — F§7.2
   * stores it as that document's model, which is what makes summaries work on a device that has never synced —
   * and left out when the hub is the only end that has it.
   */
  requestSummary(docId: string, mode: SummaryMode, document?: DocumentModel): Promise<SummaryStatus>;
  /** `GET /v1/ai/summary/:docId?mode=` — what the hub holds for one document and mode, asking for nothing. */
  getSummary(docId: string, mode: SummaryMode): Promise<SummaryStatus>;
  /**
   * Poll that state until the job is finished, or until ten minutes have passed (F§9).
   *
   * Answers the last state the hub gave: `done` or `error` when the job finished, and whatever it was still
   * saying when the deadline passed. An aborted wait rejects with an `AbortError` instead, and a poll that
   * fails — a hub that cannot be reached, a refusal — rejects with that failure.
   */
  waitForSummary(docId: string, mode: SummaryMode, options: WaitForSummaryOptions): Promise<SummaryStatus>;
}

/** The delays before the first three polls, in milliseconds (F§9): one second, then two, then three. */
const POLL_DELAYS_MS: readonly number[] = [1000, 2000, 3000];

/** How often the hub is asked once the first three polls are done (F§9). */
const STEADY_POLL_MS = 5000;

/** The longest a wait may run, in milliseconds: ten minutes (F§9). */
const WAIT_DEADLINE_MS = 600_000;

/** The content type the request's JSON body is sent with. */
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * F§7.2's error envelope, with U-054's AI codes allowed beside the shared set.
 *
 * Three of F§9's refusals (`AI_DISABLED`, `MODEL_MISSING`, `INTERRUPTED`) are codes F§7.2's closed set has no
 * place for, and the hub answers them in the same envelope with the AI code set. They are read here so a
 * refusal is never mistaken for a hub that answered nothing at all.
 */
const RefusalSchema = z.strictObject({ error: z.union([ErrorBodySchema.shape.error, SummaryErrorSchema]) });

/** An error's message, whatever was thrown. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The failure an abandoned wait rejects with: `AbortError` is the name a caller switches on. */
function aborted(): Error {
  const error = new Error("the wait for the summary was abandoned (F§9)");
  error.name = "AbortError";
  return error;
}

/**
 * What one request states besides its path: the method, the headers it adds, and its body.
 *
 * The body is an `ArrayBuffer`-backed view rather than any `Uint8Array`: `BodyInit` admits only bytes over a
 * plain `ArrayBuffer`, so a caller hands over a copy (`new Uint8Array(bytes)`) rather than a view that might
 * sit on a `SharedArrayBuffer`.
 */
interface RequestInitLike {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
}

/** F§7.2's error envelope, read from a response that is not `ok`. */
async function refusal(response: Response, path: string): Promise<AiClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const envelope = RefusalSchema.safeParse(payload);
  if (!envelope.success) {
    return new AiClientError({
      code: "INTERNAL",
      status: response.status,
      message: `${path} answered ${response.status} without F§7.2's error envelope`,
    });
  }
  const { code, message } = envelope.data.error;
  const shared = ErrorCodeSchema.safeParse(code);
  if (shared.success) return new AiClientError({ code: shared.data, status: response.status, message });
  const ai = AiErrorCodeSchema.safeParse(code);
  if (ai.success) return new AiClientError({ code: ai.data, status: response.status, message });
  return new AiClientError({
    code: "INTERNAL",
    status: response.status,
    message: `${path} refused with the code ${code}, which neither F§7.2's set nor F§9's has a place for`,
  });
}

/** The client's refusal of a request it will not send, as this module's own error type. */
function refuse(cause: unknown, message: string): AiClientError {
  return new AiClientError({ code: "BAD_REQUEST", status: 0, message: `${message} — ${messageOf(cause)}` });
}

/**
 * `createAiClient({ baseUrl, token, fetch })` — F§7.2's two AI routes as typed calls.
 *
 * A transport failure is the client's own `ENGINE_UNAVAILABLE` with `offline: true` and status `0`, because
 * there is no hub answer to report; a hub's refusal keeps the code and the message the hub sent, whichever of
 * the two sets the code belongs to. An answer whose body is not the shape the contract defines is `INTERNAL`,
 * which is what a caller sees when the two ends of a request have drifted apart.
 */
export function createAiClient(options: AiClientOptions): AiClient {
  const base = new URL(options.baseUrl);

  const send = async (path: string, init: RequestInitLike): Promise<Response> => {
    const headers = { authorization: `Bearer ${options.token}`, ...init.headers };
    let response: Response;
    try {
      response = await options.fetch(new URL(path, base), {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch (cause) {
      throw new AiClientError({
        code: "ENGINE_UNAVAILABLE",
        status: 0,
        offline: true,
        message: `the hub at ${base.origin} could not be reached — ${messageOf(cause)}`,
      });
    }
    if (!response.ok) throw await refusal(response, path);
    return response;
  };

  const read = async (response: Response, path: string, parse: (payload: unknown) => SummaryStatus): Promise<SummaryStatus> => {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    try {
      return parse(payload);
    } catch (cause) {
      throw new AiClientError({
        code: "INTERNAL",
        status: response.status,
        message: `${path} answered a body that is not the shape F§7.2 defines — ${messageOf(cause)}`,
      });
    }
  };

  const statusPath = (docId: string, mode: SummaryMode): string =>
    `/v1/ai/summary/${encodeURIComponent(docId)}?mode=${encodeURIComponent(mode)}`;

  const getSummary = async (docId: string, mode: SummaryMode): Promise<SummaryStatus> =>
    await read(await send(statusPath(docId, mode), { method: "GET" }), "/v1/ai/summary", (payload) => SummaryStatusSchema.parse(payload));

  return {
    requestSummary: async (docId, mode, document) => {
      let body: unknown;
      try {
        // F§9's own request shape, so a document whose id is not F§5.2's is refused here rather than by a hub.
        body = SummaryRequestSchema.parse(document === undefined ? { docId, mode } : { docId, mode, document });
      } catch (cause) {
        throw refuse(cause, "a summary request names a document (F§5.2) and one of F§9's two modes");
      }
      return await read(
        await send("/v1/ai/summary", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }),
        "/v1/ai/summary",
        (payload) => SummaryStatusSchema.parse(payload),
      );
    },

    getSummary,

    waitForSummary: async (docId, mode, waitOptions) =>
      await new Promise<SummaryStatus>((resolve, reject) => {
        const { clock, signal, onStatus } = waitOptions;
        const startedAt = clock.now();
        let latest: SummaryStatus = { status: "none" };
        let handle: number | null = null;
        let polled = 0;

        const stopPolling = (): void => {
          if (handle === null) return;
          clock.clearTimeout(handle);
          handle = null;
        };

        const finish = (status: SummaryStatus): void => {
          stopPolling();
          signal?.removeEventListener("abort", onAbort);
          resolve(status);
        };

        const fail = (cause: unknown): void => {
          stopPolling();
          signal?.removeEventListener("abort", onAbort);
          reject(cause);
        };

        /** An abandoned wait is over: the timer goes and the caller hears about it. */
        function onAbort(): void {
          fail(aborted());
        }

        const schedule = (): void => {
          // F§9's ten minutes are counted from the request, so a wait that has spent them answers what it has.
          if (clock.now() - startedAt >= WAIT_DEADLINE_MS) {
            finish(latest);
            return;
          }
          const delay = POLL_DELAYS_MS[polled] ?? STEADY_POLL_MS;
          polled += 1;
          handle = clock.setTimeout(() => {
            handle = null;
            void poll();
          }, delay);
        };

        const poll = async (): Promise<void> => {
          let status: SummaryStatus;
          try {
            status = await getSummary(docId, mode);
          } catch (cause) {
            fail(cause);
            return;
          }
          if (signal?.aborted === true) return;
          latest = status;
          onStatus?.(status);
          if (status.status === "done" || status.status === "error") {
            finish(status);
            return;
          }
          schedule();
        };

        if (signal?.aborted === true) {
          fail(aborted());
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        schedule();
      }),
  };
}
