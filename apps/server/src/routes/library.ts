/**
 * Phase 5's library document routes (F§7.2, F§8.4): one document's gzipped model and, when the client had one,
 * its original file — both addressed by the `docId` in the path.
 *
 * The bytes are files rather than rows (F§8.4), so this module is a thin skin over U-055's document files:
 * it reads the body, proves it is what it claims to be, and hands it over. A model travels exactly as the
 * client sent it, because a client that fetches one back expects the bytes it uploaded; the hub validates a
 * model to refuse a malformed one, never to re-encode it.
 *
 * Three properties the contract fixes:
 *
 * - **A model's own `docId` must be the path's.** The identifier names the directory the bytes are written
 *   into (F§8.4), so a body that describes another document is refused rather than filed under a name a
 *   reader would later open and find the wrong text in (the contract's *Forbidden Actions*).
 * - **A body is bounded while it streams.** The route's own `bodyLimit` is the smaller of U-054's ceiling for
 *   that file and F§7.1's `LECTERN_MAX_UPLOAD_MB`, so an oversized upload is refused as it arrives rather
 *   than held whole, and the decompressed model is bounded by the same ceiling.
 * - **A missing file is `NOT_FOUND`, never an empty answer.** A `200` with no body would read as a document
 *   with no text, which is a different thing from a document this hub was never sent.
 */

import { DocIdParamSchema, MAX_MODEL_UPLOAD_BYTES, MAX_ORIGINAL_UPLOAD_BYTES } from "@lectern/api-contract";
import { type DocumentModel, DocumentModelSchema } from "@lectern/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HubContext } from "../context";
import { describeIssues, HubError, messageOf } from "../errors";

/** The type a model's bytes are served as: a gzip container, exactly as F§7.2 describes it. */
const MODEL_MIME = "application/gzip";

/** The type an original is served as when the request declared none. */
const DEFAULT_ORIGINAL_MIME = "application/octet-stream";

/** The subset of the host's `node:zlib` this module uses, reached by a specifier in `decompress` below. */
interface HostZlib {
  gunzipSync(buffer: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
}

/**
 * The host's zlib, reached through a `string`-typed specifier rather than a literal `node:` import, so this
 * package's program keeps no Node ambient types in it — the boundary U-019 drew for `node:fs/promises` and
 * `document-files.ts` reuses. A dynamic import of a non-literal specifier type-checks without `@types/node`
 * and still loads the real module under vitest.
 */
async function hostZlib(): Promise<HostZlib> {
  const specifier: string = "node:zlib";
  return (await import(specifier)) as HostZlib;
}

/** The document id in the path, refused before any file is touched (F§5.2). */
function docIdOf(request: FastifyRequest<{ Params: { docId: string } }>): string {
  const parsed = DocIdParamSchema.safeParse(request.params.docId);
  if (!parsed.success) {
    throw new HubError(
      "BAD_REQUEST",
      `the document id in the path is not 32 lower-case hexadecimal characters (F§5.2): ${JSON.stringify(request.params.docId)}`,
    );
  }
  return parsed.data;
}

/** The bytes of an upload: Fastify's own buffer parser hands a `Uint8Array` for every type but JSON. */
function bodyBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  throw new HubError("BAD_REQUEST", "the request body did not arrive as bytes — these routes take the file itself (F§7.2)");
}

/**
 * `modelFrom(bytes, docId)` — the `DocumentModel` a gzipped body claims to be, or the refusal that names what
 * was wrong with it.
 *
 * The body must be gzip; the decompressed text must be JSON; the JSON must be F§5.1's document; and the
 * document's own `docId` must be the one in the path. `maxOutputLength` bounds the decompressed bytes, so a
 * small gzip bomb is refused with the same 413 an oversized upload earns rather than filling memory.
 */
async function modelFrom(bytes: Uint8Array, docId: string): Promise<DocumentModel> {
  const zlib = await hostZlib();
  let inflated: Uint8Array;
  try {
    inflated = zlib.gunzipSync(bytes, { maxOutputLength: MAX_MODEL_UPLOAD_BYTES });
  } catch (cause) {
    const tooLarge = (cause as { code?: unknown } | undefined)?.code === "ERR_BUFFER_TOO_LARGE";
    if (tooLarge) throw new HubError("PAYLOAD_TOO_LARGE", `the model decompresses past ${MAX_MODEL_UPLOAD_BYTES} bytes (F§7.2)`);
    throw new HubError("BAD_REQUEST", `the model body is not valid gzip (F§7.2) — ${messageOf(cause)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(inflated)) as unknown;
  } catch (cause) {
    throw new HubError("BAD_REQUEST", `the model body is not JSON — ${messageOf(cause)}`);
  }
  const parsed = DocumentModelSchema.safeParse(value);
  if (!parsed.success) throw new HubError("BAD_REQUEST", `the model is not a document — ${describeIssues(parsed.error)}`);
  if (parsed.data.docId !== docId) {
    throw new HubError("BAD_REQUEST", `the model describes the document ${parsed.data.docId}, not the one in the path (${docId})`);
  }
  return parsed.data;
}

/**
 * One file's ceiling: U-054's limit for that file, capped by F§7.1's operator-configured upload size. The
 * smaller of the two is what a body is read under, so a hub told to accept less than the contract's ceiling
 * accepts less, and never more.
 */
function ceilingFor(limit: number, ctx: HubContext): number {
  return Math.min(limit, ctx.config.maxUploadMb * 1024 * 1024);
}

export function libraryRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.put<{ Params: { docId: string } }>(
    "/v1/library/documents/:docId/model",
    { bodyLimit: ceilingFor(MAX_MODEL_UPLOAD_BYTES, ctx) },
    async (request, reply): Promise<void> => {
      const docId = docIdOf(request);
      const bytes = bodyBytes(request.body);
      await modelFrom(bytes, docId);
      await ctx.files.putModel(docId, bytes);
      reply.status(204).send();
    },
  );

  app.get<{ Params: { docId: string } }>("/v1/library/documents/:docId/model", async (request, reply): Promise<void> => {
    const docId = docIdOf(request);
    const bytes = await ctx.files.getModel(docId);
    if (bytes === null) throw new HubError("NOT_FOUND", `this hub holds no model for the document ${docId}`);
    reply.type(MODEL_MIME);
    reply.send(bytes);
  });

  app.put<{ Params: { docId: string } }>(
    "/v1/library/documents/:docId/original",
    { bodyLimit: ceilingFor(MAX_ORIGINAL_UPLOAD_BYTES, ctx) },
    async (request, reply): Promise<void> => {
      const docId = docIdOf(request);
      const bytes = bodyBytes(request.body);
      const declared = request.headers["content-type"];
      const mime = typeof declared === "string" && declared !== "" ? declared : DEFAULT_ORIGINAL_MIME;
      await ctx.files.putOriginal(docId, bytes, mime);
      reply.status(204).send();
    },
  );

  app.get<{ Params: { docId: string } }>("/v1/library/documents/:docId/original", async (request, reply): Promise<void> => {
    const docId = docIdOf(request);
    const original = await ctx.files.getOriginal(docId);
    if (original === null) throw new HubError("NOT_FOUND", `this hub holds no original for the document ${docId}`);
    reply.type(original.mime);
    reply.send(original.bytes);
  });
}
