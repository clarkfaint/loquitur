/**
 * The Kokoro adapter (F§6): Lectern's own client for an operator-run Kokoro-FastAPI container, reached over
 * HTTP with the host's `fetch`.
 *
 * The module is isomorphic — it imports nothing from Node — so the hub and the desktop app can both run it.
 * The service's address is configuration, every answer is validated before it is used, and the two
 * endpoints F§6 allows are the only ones this file knows.
 */

import type { EngineToken } from "@lectern/core";
import { z } from "zod";
import { type SynthesisRequest, type SynthesisResult, type TtsEngine, type Voice, voiceIdFor } from "./engine";
import { readMp3DurationMs } from "./mp3";

/** The scheme half of every voice id this engine serves (F§6). */
const ENGINE_ID = "kokoro";

/** The model `POST /dev/captioned_speech` is asked for (F§6): the container serves this one. */
const MODEL = "kokoro";

/** The only two endpoints this adapter calls (F§6), and nothing else. */
const VOICES_PATH = "/v1/audio/voices";
const SPEECH_PATH = "/dev/captioned_speech";

/** The container F§6 asks the service for, so `readMp3DurationMs` can read the audio's own length back. */
const RESPONSE_FORMAT = "mp3";

/** F§6's engine speed range: a request outside it is clamped into it rather than refused. */
const MIN_SYNTH_SPEED = 0.25;
const MAX_SYNTH_SPEED = 4;

/** How long the backend has to answer before the adapter gives up on it. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** The adapter's deadline is configured in milliseconds; the service reports its timestamps in seconds. */
const MS_PER_SECOND = 1000;
const CONTENT_TYPE = "application/json";

/**
 * The host globals this module is built on. `lib: ES2022` declares neither the timers nor the browser's
 * HTTP and base64 primitives, and R10 forbids adding the typings package that would, so each one is
 * declared here with the signature this adapter actually uses — no wider.
 */
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;
declare const AbortController: new () => { readonly signal: unknown; abort: () => void };
declare const atob: (encoded: string) => string;

/**
 * What this adapter needs of a request: the method, a JSON content type and body, and a signal a real
 * transport can abandon the socket with. A `RequestInit` is wider than this, which is what lets a host pass
 * its own `fetch` and a test its own stub. `body` is absent on a request that carries none, because the
 * host's `fetch` refuses a body on a GET.
 */
export interface KokoroRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
}

/** What this adapter needs of an answer: whether it succeeded, its status, and its JSON body. */
export interface KokoroAnswer {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** The transport this adapter speaks over (F§6): the host's `fetch`, or one an operator injects. */
export type KokoroFetch = (url: string, request: KokoroRequest) => Promise<KokoroAnswer>;

/** The refusal this adapter reports (F§6): the backend could not be reached, or answered nothing usable. */
export type KokoroEngineErrorCode = "ENGINE_UNAVAILABLE";

/**
 * The one failure a Kokoro request has: the service did not answer — it was unreachable, it answered an
 * error, its deadline passed — or it answered something this adapter cannot read. `code` is what the hub
 * reports to the reader, so a container that is down is a recognizable state rather than a bare string.
 */
export class KokoroEngineError extends Error {
  readonly code: KokoroEngineErrorCode;

  constructor(code: KokoroEngineErrorCode, message: string) {
    super(message);
    this.name = "KokoroEngineError";
    this.code = code;
  }
}

/** One word of `timestamps`, in the seconds the service reports (F§6). */
const TimestampSchema = z.object({ word: z.string(), start_time: z.number(), end_time: z.number() });
type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * The speech answer (F§6): base64 audio and one timestamp per word the model can time. Fields this adapter
 * does not read are ignored rather than refused — another project's service answers here, and a field it
 * adds must not break synthesis.
 */
const CaptionedSpeechSchema = z.object({ audio: z.string(), timestamps: z.array(TimestampSchema) });

/**
 * The voice list (F§6): voices come from the service, never from a list in this file. The service answers
 * either an object holding the ids or a bare array of them.
 */
const VoicesSchema = z.union([z.array(z.string()), z.object({ voices: z.array(z.string()) })]);

/** What an operator configures the adapter with (F§6). */
export interface KokoroEngineOptions {
  baseUrl: string;
  fetch?: KokoroFetch;
  timeoutMs?: number;
}

/** A caught value's message, for this adapter's own refusals. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `synthSpeed` clamped into F§6's range for an engine. */
function clampSynthSpeed(synthSpeed: number): number {
  return Math.min(Math.max(synthSpeed, MIN_SYNTH_SPEED), MAX_SYNTH_SPEED);
}

/** Seconds as the service reports them, in whole milliseconds. */
function toMs(seconds: number): number {
  return Math.round(seconds * MS_PER_SECOND);
}

/** The paths a zod refusal names, so an unreadable answer is diagnosable from the message alone. */
function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.join("."));
  return paths.length === 0 ? "the value itself" : paths.join(", ");
}

/** The host's `fetch`, or `null` when this host has none: the global is not typed here (no DOM library). */
function hostFetch(): KokoroFetch | null {
  const candidate: unknown = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as KokoroFetch) : null;
}

/**
 * A voice the service offers, as F§6's `Voice` wants it: the global id, this engine, the service's own id as
 * both the engine voice id and the display name, and the language the service's own id prefixes it with
 * (`af_heart` is an `af` voice) — the service reports no language of its own.
 */
function toVoice(engineVoiceId: string): Voice {
  const separator = engineVoiceId.indexOf("_");
  return {
    id: voiceIdFor(ENGINE_ID, engineVoiceId),
    engine: ENGINE_ID,
    engineVoiceId,
    name: engineVoiceId,
    lang: separator > 0 ? engineVoiceId.slice(0, separator) : "",
  };
}

/** The base64 audio decoded to bytes. A string the host cannot decode is a refusal, not an empty stream. */
function decodeAudio(encoded: string, url: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (cause) {
    throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${url} answered audio that is not base64: ${messageOf(cause)}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return bytes;
}

/** The audio's own length, read from the MP3 frames the service returned. */
function audioDurationMs(audio: Uint8Array, url: string): number {
  try {
    return readMp3DurationMs(audio);
  } catch (cause) {
    throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${url} returned audio with no readable duration: ${messageOf(cause)}`);
  }
}

/**
 * The word timestamps as engine tokens, or `null` when the service timed no word at all — F§6's empty array
 * means the model cannot time this language, and the alignment path estimates timings instead.
 */
function toEngineTokens(timestamps: readonly Timestamp[]): EngineToken[] | null {
  if (timestamps.length === 0) return null;
  return timestamps.map((timestamp) => ({ text: timestamp.word, s: toMs(timestamp.start_time), e: toMs(timestamp.end_time) }));
}

/**
 * One call to the backend: this adapter's own deadline, and one refusal for every way it can fail — an
 * unreachable service, an HTTP error, a body that is not JSON, and the deadline passing.
 *
 * The signal is passed on, so a real `fetch` abandons the socket at the deadline; the race is what makes the
 * deadline hold for a transport that ignores the signal. The abandoned request is caught here, because
 * nothing is waiting for it once the deadline has answered.
 */
async function callEngine(fetchImpl: KokoroFetch, url: string, method: string, body: string | null, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: unknown = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  // A request with no body carries neither a content type nor a body: the host's `fetch` refuses the latter.
  const request: KokoroRequest = {
    method,
    headers: body === null ? {} : { "content-type": CONTENT_TYPE },
    ...(body === null ? {} : { body }),
    signal: controller.signal,
  };
  const pending = fetchImpl(url, request);
  pending.catch(() => undefined);
  try {
    const answer = await Promise.race([pending, deadline]);
    if (answer === null) throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${url} did not answer within ${timeoutMs} ms`);
    if (!answer.ok) throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${url} answered HTTP ${answer.status}`);
    return await answer.json();
  } catch (cause) {
    if (cause instanceof KokoroEngineError) throw cause;
    throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${url} could not be read: ${messageOf(cause)}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * `createKokoroEngine({ baseUrl, fetch?, timeoutMs? })` — F§6's Kokoro adapter.
 *
 * Voices come from the service, so the adapter holds no voice list; the engine speed is clamped into F§6's
 * range; the timestamps become integer milliseconds; and the duration is the later of the audio's own length
 * and the last token's end, so a service whose tokens outlast its audio is still reported honestly.
 */
export function createKokoroEngine(options: KokoroEngineOptions): TtsEngine {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const injected = options.fetch;
  const voicesUrl = `${baseUrl}${VOICES_PATH}`;
  const speechUrl = `${baseUrl}${SPEECH_PATH}`;

  /** The transport to use: the operator's, or the host's own — refused only when there is no way to reach the service. */
  const transport = (): KokoroFetch => {
    const resolved = injected ?? hostFetch();
    if (resolved === null) throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${speechUrl} is unreachable: this host has no fetch`);
    return resolved;
  };

  return {
    id: ENGINE_ID,

    listVoices: async (): Promise<Voice[]> => {
      const answer = await callEngine(transport(), voicesUrl, "GET", null, timeoutMs);
      const parsed = VoicesSchema.safeParse(answer);
      if (!parsed.success) {
        throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${voicesUrl} answered no readable voice list at ${issuePaths(parsed.error)}`);
      }
      const ids = Array.isArray(parsed.data) ? parsed.data : parsed.data.voices;
      return ids.map(toVoice);
    },

    synthesize: async (request: SynthesisRequest): Promise<SynthesisResult> => {
      const payload = {
        model: MODEL,
        input: request.text,
        voice: request.engineVoiceId,
        speed: clampSynthSpeed(request.synthSpeed),
        response_format: RESPONSE_FORMAT,
        stream: false,
      };
      const answer = await callEngine(transport(), speechUrl, "POST", JSON.stringify(payload), timeoutMs);
      const parsed = CaptionedSpeechSchema.safeParse(answer);
      if (!parsed.success) {
        throw new KokoroEngineError("ENGINE_UNAVAILABLE", `${speechUrl} answered no readable speech at ${issuePaths(parsed.error)}`);
      }
      const { audio: encoded, timestamps } = parsed.data;
      const audio = decodeAudio(encoded, speechUrl);
      const last = timestamps.at(-1);
      return {
        audio,
        mime: "audio/mpeg",
        durationMs: Math.max(audioDurationMs(audio, speechUrl), last === undefined ? 0 : toMs(last.end_time)),
        engineTokens: toEngineTokens(timestamps),
      };
    },
  };
}
