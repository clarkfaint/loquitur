/**
 * The sync client (F§7.2, F§8.2): the phase-5 routes an F§8 round is made of — one push, one pull, and the
 * four calls that carry a document's body beside its record.
 *
 * It is built the way U-021's hub client is: the origin, the token and the transport arrive as arguments, so
 * the same code serves the web app, the extension, the desktop app and a test, and no global `fetch` appears
 * anywhere in this package. The token travels in the `Authorization` header of every call and never in a URL
 * (F§11).
 *
 * **Compression is injected as a text codec.** F§7.2 carries a model as a gzip container, and the two halves
 * of that exchange are not the same value: `gzip` is handed the model's JSON text and answers the container,
 * `gunzip` is handed the container and answers the text it holds. Keeping the seam at *text* is what lets
 * this package stay free of every platform's byte handling — no `TextEncoder`, no `CompressionStream`, no
 * `node:zlib` — while each of the four platforms supplies its own two lines.
 *
 * Both directions are validated with `@lectern/api-contract`: what a caller asks this client to send, so a
 * push past F§8.2's 200-op ceiling is refused before a byte leaves, and what the hub answers, so a hub that
 * has drifted from the contract fails here rather than inside a store.
 */

import {
  ErrorBodySchema,
  ErrorCodeSchema,
  MAX_PUSH_OPS,
  PullQuerySchema,
  type PullResponse,
  PullResponseSchema,
  PushRequestSchema,
  type PushResponse,
  PushResponseSchema,
  SyncErrorSchema,
} from "@lectern/api-contract";
import { type DocumentModel, DocumentModelSchema, type Op } from "@lectern/core";
import { z } from "zod";
import { HubClientError } from "./errors";

/** The model's JSON text as the gzip container F§7.2 carries it (`PUT …/model`). */
export type SyncGzip = (text: string) => Promise<Uint8Array>;

/** The gzip container as the JSON text it holds (`GET …/model`). */
export type SyncGunzip = (bytes: Uint8Array) => Promise<string>;

/** What a sync client is built from: the hub's address, the token, the transport, and the codec pair above. */
export interface SyncClientOptions {
  /** The hub's origin, for example `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** F§11's single pre-shared bearer token. */
  token: string;
  /** The transport. Injected, so the client is isomorphic and a test drives it without a socket. */
  fetch: typeof fetch;
  /** gzip: F§7.2's model bodies leave as a container. */
  gzip: SyncGzip;
  /** gunzip: the container a model comes back in. */
  gunzip: SyncGunzip;
}

/** A document's original file as the hub serves it back (F§7.2): its bytes and the type it was stored under. */
export interface StoredOriginal {
  bytes: Uint8Array;
  mime: string;
}

/** The hub's phase-5 sync and document-file routes (F§7.2), as one typed client. */
export interface SyncClient {
  /**
   * `POST /v1/sync/push` — one device's pending ops, at most F§8.2's 200. Every opId the hub accepted comes
   * back, including the ops that lost the last-writer-wins rule, so a caller acknowledges exactly what
   * arrived and never what it hoped arrived.
   */
  push(deviceId: string, ops: readonly Op[]): Promise<PushResponse>;
  /** `GET /v1/sync/pull?since=&limit=` — the changes after `since`, one op per changed entity (F§8.2). */
  pull(since: number, limit?: number): Promise<PullResponse>;
  /** `PUT /v1/library/documents/:docId/model` — a document's model, gzipped (F§8.2's first round step). */
  putModel(docId: string, model: DocumentModel): Promise<void>;
  /** `GET /v1/library/documents/:docId/model` — the model, or `null` when the hub holds none. */
  getModel(docId: string): Promise<DocumentModel | null>;
  /** `PUT /v1/library/documents/:docId/original` — the source bytes a document was read from, if any. */
  putOriginal(docId: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** `GET /v1/library/documents/:docId/original` — the original, or `null` when the hub holds none. */
  getOriginal(docId: string): Promise<StoredOriginal | null>;
}

/** The content type a model's container is sent with, and the one the hub serves it as (F§7.2). */
const MODEL_MIME = "application/gzip";

/** The content type an original is described with when the caller states none. */
const DEFAULT_ORIGINAL_MIME = "application/octet-stream";

/** The content type the push's JSON body is sent with. */
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * F§7.2's error envelope, with U-054's sync codes allowed beside the shared set.
 *
 * Two of F§8.2's refusals (`TOO_MANY_OPS`, `MODEL_MISSING`) are codes F§7.2's closed set has no place for,
 * and a hub answers them in the same envelope. They are read here so a refusal is never mistaken for a hub
 * that answered nothing at all; `HubClientError.code` carries F§7.2's own set, so a sync code is reported as
 * this client's own failure with the hub's code quoted in the message (see `refusal`).
 */
const RefusalSchema = z.strictObject({ error: z.union([ErrorBodySchema.shape.error, SyncErrorSchema]) });

/** An error's message, whatever was thrown. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * What one request states besides its path: the method, the headers it adds, and its body.
 *
 * The body is an `ArrayBuffer`-backed view rather than any `Uint8Array`: `BodyInit` admits only bytes over a
 * plain `ArrayBuffer`, so a container is copied (`new Uint8Array(bytes)`) rather than handed over as the
 * view a codec returned.
 */
interface RequestInitLike {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
}

/** The client's refusal of a request it will not send (F§8.2's limits), as F§7.2's own error type. */
function refuse(cause: unknown, message: string): HubClientError {
  return new HubClientError({ code: "BAD_REQUEST", status: 0, message: `${message} — ${messageOf(cause)}` });
}

/** F§7.2's error envelope, read from a response that is not `ok`. */
async function refusal(response: Response, path: string): Promise<HubClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const envelope = RefusalSchema.safeParse(payload);
  if (!envelope.success) {
    return new HubClientError({
      code: "INTERNAL",
      status: response.status,
      message: `${path} answered ${response.status} without F§7.2's error envelope`,
    });
  }
  const { code, message } = envelope.data.error;
  const shared = ErrorCodeSchema.safeParse(code);
  if (shared.success) return new HubClientError({ code: shared.data, status: response.status, message });
  return new HubClientError({
    code: "INTERNAL",
    status: response.status,
    message: `${path} refused with the sync code ${code}, which F§7.2's shared set has no place for (F§8.2) — ${message}`,
  });
}

/**
 * `createSyncClient({ baseUrl, token, fetch, gzip, gunzip })` — F§8's routes as typed calls.
 *
 * A transport failure is the client's own `ENGINE_UNAVAILABLE` with `offline: true` and status `0`, because
 * there is no hub answer to report; a hub's refusal keeps the code and the message the hub sent. An answer
 * whose body is not the shape the contract defines is `INTERNAL`, which is what a caller sees when the two
 * ends of a request have drifted apart.
 */
export function createSyncClient(options: SyncClientOptions): SyncClient {
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

  /**
   * One file's answer, with F§7.2's `NOT_FOUND` read as "the hub holds none" rather than as a failure: a
   * document's body is optional (F§8.2 downloads a model lazily), so a caller has to be able to tell a
   * missing file from a hub that could not be asked.
   */
  const sendAllowingMissing = async (path: string, method: string): Promise<Response | null> => {
    try {
      return await send(path, { method });
    } catch (cause) {
      if (cause instanceof HubClientError && cause.status === 404) return null;
      throw cause;
    }
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

  const documentPath = (docId: string, file: "model" | "original"): string => `/v1/library/documents/${encodeURIComponent(docId)}/${file}`;

  return {
    push: async (deviceId, ops) => {
      let body: unknown;
      try {
        body = PushRequestSchema.parse({ deviceId, ops });
      } catch (cause) {
        throw refuse(cause, `a push carries one device's ops, at least one and at most ${MAX_PUSH_OPS} (F§8.2)`);
      }
      return await read(
        await send("/v1/sync/push", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }),
        "/v1/sync/push",
        (payload) => PushResponseSchema.parse(payload),
      );
    },

    pull: async (since, limit) => {
      let query: { since: number; limit: number };
      try {
        query = PullQuerySchema.parse(limit === undefined ? { since } : { since, limit });
      } catch (cause) {
        throw refuse(cause, "a pull names the rev it has seen and a page size F§8.2 allows");
      }
      const path = `/v1/sync/pull?since=${query.since}&limit=${query.limit}`;
      return await read(await send(path, { method: "GET" }), "/v1/sync/pull", (payload) => PullResponseSchema.parse(payload));
    },

    putModel: async (docId, model) => {
      const text = JSON.stringify(DocumentModelSchema.parse(model));
      const path = documentPath(docId, "model");
      await send(path, {
        method: "PUT",
        headers: { "content-type": MODEL_MIME },
        body: new Uint8Array(await options.gzip(text)),
      });
    },

    getModel: async (docId) => {
      const path = documentPath(docId, "model");
      const response = await sendAllowingMissing(path, "GET");
      if (response === null) return null;
      const container = new Uint8Array(await response.arrayBuffer());
      try {
        return DocumentModelSchema.parse(JSON.parse(await options.gunzip(container)) as unknown);
      } catch (cause) {
        throw new HubClientError({
          code: "INTERNAL",
          status: response.status,
          message: `${path} answered a body that is not the document F§7.2 defines — ${messageOf(cause)}`,
        });
      }
    },

    putOriginal: async (docId, bytes, mime) => {
      await send(documentPath(docId, "original"), {
        method: "PUT",
        headers: { "content-type": mime === "" ? DEFAULT_ORIGINAL_MIME : mime },
        body: new Uint8Array(bytes),
      });
    },

    getOriginal: async (docId) => {
      const response = await sendAllowingMissing(documentPath(docId, "original"), "GET");
      if (response === null) return null;
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mime: response.headers.get("content-type") ?? DEFAULT_ORIGINAL_MIME,
      };
    },
  };
}
