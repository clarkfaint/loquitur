/**
 * The hub client (F§7.2): one typed call per phase-1 route, over an injected `fetch`.
 *
 * Everything the client needs arrives in `createHubClient`, so the same code serves the web app, the
 * extension, the desktop app and a test: no global `fetch`, no `window`, no `process.env`, and no HTTP
 * library. The token travels in the `Authorization` header of every request and never in a URL (F§11).
 *
 * Every answer is validated with `@lectern/api-contract` before it is handed back, so a hub that drifted from
 * the contract fails here, at the boundary, instead of somewhere inside a reader.
 */

import {
  ErrorBodySchema,
  FILENAME_HEADER,
  type HealthResponse,
  HealthResponseSchema,
  type ParseResponse,
  ParseResponseSchema,
  type TtsResponse,
  TtsResponseSchema,
  type VoicesResponse,
  VoicesResponseSchema,
} from "@lectern/api-contract";
import { HubClientError } from "./errors";

/** What a client is built from: the hub's address, the shared token, and the transport that reaches it. */
export interface HubClientOptions {
  /** The hub's origin, for example `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** F§11's single pre-shared bearer token. */
  token: string;
  /** The transport. Injected, so the client is isomorphic and a test drives it without a socket. */
  fetch: typeof fetch;
}

/** F§7.2's synthesis request as a caller writes it: `synthSpeed` defaults to 1, the speed a cache serves. */
export interface TtsRequestInput {
  text: string;
  voiceId: string;
  synthSpeed?: number;
}

/** The hub's phase-1 routes (F§7.2), as one typed client. */
export interface HubClient {
  /** `GET /healthz` — the probe, which answers without a token. */
  health(): Promise<HealthResponse>;
  /** `GET /v1/voices` — F§6's voices of every enabled engine. */
  voices(): Promise<VoicesResponse>;
  /** `POST /v1/tts` — one chunk, answered from the hub's cache when it already holds it (F§7.3). */
  tts(request: TtsRequestInput): Promise<TtsResponse>;
  /** `GET /v1/tts/audio/:chunkId` — the chunk's own bytes. */
  ttsAudio(chunkId: string): Promise<Uint8Array>;
  /** `POST /v1/parse` in its raw-bytes form: the file itself, the name it has, and the type it claims. */
  parseFile(bytes: Uint8Array, filename: string, mime: string): Promise<ParseResponse>;
  /** `POST /v1/parse` in its `{ url }` form: a page the hub fetches under F§7.2's fetch rules. */
  parseUrl(url: string): Promise<ParseResponse>;
  /** `POST /v1/parse` in its `{ text, title? }` form: text the caller already holds. */
  parseText(text: string, title?: string): Promise<ParseResponse>;
}

/** The content type the JSON forms of `POST /v1/tts` and `POST /v1/parse` are sent with. */
const JSON_HEADERS = { "content-type": "application/json" };

/** An error's message, whatever was thrown. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
async function refusal(response: Response, path: string): Promise<HubClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const envelope = ErrorBodySchema.safeParse(payload);
  if (envelope.success) {
    return new HubClientError({ code: envelope.data.error.code, status: response.status, message: envelope.data.error.message });
  }
  return new HubClientError({
    code: "INTERNAL",
    status: response.status,
    message: `${path} answered ${response.status} without F§7.2's error envelope`,
  });
}

/**
 * `createHubClient({ baseUrl, token, fetch })` — F§7.2's routes as typed calls.
 *
 * A transport failure is the client's own `ENGINE_UNAVAILABLE` with `offline: true` and status `0`, because
 * there is no hub answer to report; a hub's refusal keeps the code and the message the hub sent. A `200` whose
 * body is not the shape the contract defines is `INTERNAL`, which is what a reader sees when the two ends of a
 * request have drifted apart.
 */
export function createHubClient(options: HubClientOptions): HubClient {
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
      throw new HubClientError({
        code: "ENGINE_UNAVAILABLE",
        status: 0,
        offline: true,
        message: `the hub at ${base.origin} could not be reached — ${messageOf(cause)}`,
      });
    }
    if (!response.ok) throw await refusal(response, path);
    return response;
  };

  const read = async <T>(response: Response, path: string, parse: (payload: unknown) => T): Promise<T> => {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    try {
      return parse(payload);
    } catch (cause) {
      throw new HubClientError({
        code: "INTERNAL",
        status: response.status,
        message: `${path} answered a body that is not the shape F§7.2 defines — ${messageOf(cause)}`,
      });
    }
  };

  return {
    health: async () => await read(await send("/healthz", { method: "GET" }), "/healthz", (payload) => HealthResponseSchema.parse(payload)),

    voices: async () =>
      await read(await send("/v1/voices", { method: "GET" }), "/v1/voices", (payload) => VoicesResponseSchema.parse(payload)),

    tts: async (request) =>
      await read(
        await send("/v1/tts", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ text: request.text, voiceId: request.voiceId, synthSpeed: request.synthSpeed ?? 1 }),
        }),
        "/v1/tts",
        (payload) => TtsResponseSchema.parse(payload),
      ),

    ttsAudio: async (chunkId) =>
      new Uint8Array(await (await send(`/v1/tts/audio/${encodeURIComponent(chunkId)}`, { method: "GET" })).arrayBuffer()),

    parseFile: async (bytes, filename, mime) =>
      await read(
        // The copy gives the body an `ArrayBuffer` of its own, which is the only backing `BodyInit` admits.
        await send("/v1/parse", {
          method: "POST",
          headers: { "content-type": mime, [FILENAME_HEADER]: filename },
          body: new Uint8Array(bytes),
        }),
        "/v1/parse",
        (payload) => ParseResponseSchema.parse(payload),
      ),

    parseUrl: async (url) =>
      await read(
        await send("/v1/parse", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ url }) }),
        "/v1/parse",
        (payload) => ParseResponseSchema.parse(payload),
      ),

    parseText: async (text, title) =>
      await read(
        await send("/v1/parse", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(title === undefined ? { text } : { text, title }),
        }),
        "/v1/parse",
        (payload) => ParseResponseSchema.parse(payload),
      ),
  };
}
