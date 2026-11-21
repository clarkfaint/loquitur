/**
 * The Piper adapter (F§6): Lectern's own client for an operator-run Piper HTTP service, reached over HTTP
 * with the host's `fetch`.
 *
 * Piper answers WAV, so the duration is the audio's own length read from the container header rather than a
 * number the service reports, and the service times no word at all — `engineTokens` is `null` here, never a
 * guess. The module is isomorphic (it imports nothing from Node), so the hub and the desktop app can both run
 * it; the service's address is configuration, every answer is validated before it is used, and the two
 * endpoints F§6 allows are the only ones this file knows.
 */

import { z } from "zod";
import { type SynthesisRequest, type SynthesisResult, type TtsEngine, type Voice, voiceIdFor } from "./engine";
import { readWavDurationMs } from "./wav";

/** The scheme half of every voice id this engine serves (F§6). */
const ENGINE_ID = "piper";

/** The only two endpoints this adapter calls (F§6), and nothing else. */
const VOICES_PATH = "/voices";
const SYNTHESIZE_PATH = "/synthesize";

/** How long the backend has to answer before the adapter gives up on it. */
const DEFAULT_TIMEOUT_MS = 30_000;
const CONTENT_TYPE = "application/json";

/** The separator a Piper voice name carries its language in front of (`en_US-lessac-medium` is an `en` voice). */
const LANGUAGE_SEPARATOR = /[-_]/;

/**
 * The host globals this module is built on. `lib` is the target alone (`ES2022`), which declares neither the
 * timers nor the abort primitive, and R10 forbids the typings package that would, so each one is declared
 * here with the signature this adapter actually uses — no wider.
 */
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;
declare const AbortController: new () => { readonly signal: unknown; abort: () => void };

/**
 * What this adapter needs of a request: the method, a JSON content type and body, and a signal a real
 * transport can abandon the socket with. A `RequestInit` is wider than this, which is what lets a host pass
 * its own `fetch` and a test its own stub. `body` is absent on a request that carries none, because the
 * host's `fetch` refuses a body on a GET.
 */
export interface PiperRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
}

/** What this adapter needs of an answer: whether it succeeded, its status, and its body as JSON or as bytes. */
export interface PiperAnswer {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/** The transport this adapter speaks over (F§6): the host's `fetch`, or one an operator injects. */
export type PiperFetch = (url: string, request: PiperRequest) => Promise<PiperAnswer>;

/** The refusal this adapter reports (F§6): the backend could not be reached, or answered nothing usable. */
export type PiperEngineErrorCode = "ENGINE_UNAVAILABLE";

/**
 * The one failure a Piper request has: the service did not answer — it was unreachable, it answered an error,
 * its deadline passed — or it answered something this adapter cannot read. `code` is what the hub reports to
 * the reader, so a container that is down is a recognizable state rather than a bare string.
 */
export class PiperEngineError extends Error {
  readonly code: PiperEngineErrorCode;

  constructor(code: PiperEngineErrorCode, message: string) {
    super(message);
    this.name = "PiperEngineError";
    this.code = code;
  }
}

/**
 * The voice list (F§6): voices come from the service, never from a list in this file. F§6 fixes the endpoint,
 * not the envelope, so a service names a voice as a bare id or as an object carrying it and answers either
 * those entries or an object holding them; an entry with no name is not a voice and is refused. piper-tts's own
 * HTTP server (1.8.0, the image F§2.3 builds) answers a third form: an object keyed by voice name whose values
 * are each voice's model config, so a key counts as a voice only when its value is such an object.
 */
const VoiceEntrySchema = z.union([z.string().min(1), z.object({ name: z.string().min(1) })]);
const VoiceConfigMapSchema = z.record(z.string().min(1), z.looseObject({}));
const VoicesSchema = z.union([z.array(VoiceEntrySchema), z.object({ voices: z.array(VoiceEntrySchema) }), VoiceConfigMapSchema]);

/** What an operator configures the adapter with (F§6). */
export interface PiperEngineOptions {
  baseUrl: string;
  fetch?: PiperFetch;
  timeoutMs?: number;
}

/** A caught value's message, for this adapter's own refusals. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The paths a zod refusal names, so an unreadable answer is diagnosable from the message alone. */
function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.join("."));
  return paths.length === 0 ? "the value itself" : paths.join(", ");
}

/** The host's `fetch`, or `null` when this host has none: the global is not typed here (no DOM library). */
function hostFetch(): PiperFetch | null {
  const candidate: unknown = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as PiperFetch) : null;
}

/**
 * A voice the service offers, as F§6's `Voice` wants it: the global id, this engine, the service's own name as
 * both the engine voice id and the display name (the service gives no nicer one), and the language the name
 * prefixes it with — the service reports no language of its own.
 */
function toVoice(engineVoiceId: string): Voice {
  const separator = engineVoiceId.search(LANGUAGE_SEPARATOR);
  return {
    id: voiceIdFor(ENGINE_ID, engineVoiceId),
    engine: ENGINE_ID,
    engineVoiceId,
    name: engineVoiceId,
    lang: separator > 0 ? engineVoiceId.slice(0, separator) : "",
  };
}

/**
 * The duration the WAV container declares. Bytes with no usable `fmt ` chunk or no `data` chunk are not audio
 * this package can play, and a refusal says so rather than reporting a duration derived from nothing.
 */
function audioDurationMs(audio: Uint8Array, url: string): number {
  try {
    return readWavDurationMs(audio);
  } catch (cause) {
    throw new PiperEngineError("ENGINE_UNAVAILABLE", `${url} returned audio with no readable duration: ${messageOf(cause)}`);
  }
}

/**
 * One call to the backend: this adapter's own deadline, and one refusal for every way it can fail — an
 * unreachable service, an HTTP error, a body the reader cannot read, and the deadline passing.
 *
 * The signal is passed on, so a real `fetch` abandons the socket at the deadline; the race is what makes the
 * deadline hold for a transport that ignores the signal. The abandoned request is caught here, because nothing
 * is waiting for it once the deadline has answered.
 */
async function callEngine<T>(
  fetchImpl: PiperFetch,
  url: string,
  method: string,
  body: string | null,
  timeoutMs: number,
  read: (answer: PiperAnswer) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: unknown = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  // A request with no body carries neither a content type nor a body: the host's `fetch` refuses the latter.
  const request: PiperRequest = {
    method,
    headers: body === null ? {} : { "content-type": CONTENT_TYPE },
    ...(body === null ? {} : { body }),
    signal: controller.signal,
  };
  const pending = fetchImpl(url, request);
  pending.catch(() => undefined);
  try {
    const answer = await Promise.race([pending, deadline]);
    if (answer === null) throw new PiperEngineError("ENGINE_UNAVAILABLE", `${url} did not answer within ${timeoutMs} ms`);
    if (!answer.ok) throw new PiperEngineError("ENGINE_UNAVAILABLE", `${url} answered HTTP ${answer.status}`);
    return await read(answer);
  } catch (cause) {
    if (cause instanceof PiperEngineError) throw cause;
    throw new PiperEngineError("ENGINE_UNAVAILABLE", `${url} could not be read: ${messageOf(cause)}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * `createPiperEngine({ baseUrl, fetch?, timeoutMs? })` — F§6's Piper adapter.
 *
 * Voices come from the service, so the adapter holds no voice list; a request carries F§6's three fields and
 * nothing else, the speed as the `length_scale` Piper takes (`1 / synthSpeed`); the duration is read out of
 * the returned WAV; and no word timing is invented, because the service reports none.
 */
export function createPiperEngine(options: PiperEngineOptions): TtsEngine {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const injected = options.fetch;
  const voicesUrl = `${baseUrl}${VOICES_PATH}`;
  const synthesizeUrl = `${baseUrl}${SYNTHESIZE_PATH}`;

  /** The transport to use: the operator's, or the host's own — refused only when there is no way to reach the service. */
  const transport = (): PiperFetch => {
    const resolved = injected ?? hostFetch();
    if (resolved === null) throw new PiperEngineError("ENGINE_UNAVAILABLE", `${synthesizeUrl} is unreachable: this host has no fetch`);
    return resolved;
  };

  return {
    id: ENGINE_ID,

    listVoices: async (): Promise<Voice[]> => {
      const answer = await callEngine(transport(), voicesUrl, "GET", null, timeoutMs, (response) => response.json());
      const parsed = VoicesSchema.safeParse(answer);
      if (!parsed.success) {
        throw new PiperEngineError("ENGINE_UNAVAILABLE", `${voicesUrl} answered no readable voice list at ${issuePaths(parsed.error)}`);
      }
      const data = parsed.data;
      const entries = Array.isArray(data) ? data : Array.isArray(data.voices) ? data.voices : Object.keys(data);
      return entries.map((entry) => toVoice(typeof entry === "string" ? entry : entry.name));
    },

    synthesize: async (request: SynthesisRequest): Promise<SynthesisResult> => {
      const payload = { text: request.text, voice: request.engineVoiceId, length_scale: 1 / request.synthSpeed };
      return callEngine(
        transport(),
        synthesizeUrl,
        "POST",
        JSON.stringify(payload),
        timeoutMs,
        async (response): Promise<SynthesisResult> => {
          const audio = new Uint8Array(await response.arrayBuffer());
          return { audio, mime: "audio/wav", durationMs: audioDurationMs(audio, synthesizeUrl), engineTokens: null };
        },
      );
    },
  };
}
