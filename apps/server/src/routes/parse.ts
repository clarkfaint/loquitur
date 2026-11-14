/**
 * `POST /v1/parse` (F§7.2): one document in, one `DocumentModel` out.
 *
 * The route has three forms and answers all of them with the same shape. Raw bytes in the body — any
 * content type but JSON — with F§7.2's `X-Lectern-Filename` header as a hint; JSON `{ url }` for a
 * page the hub fetches itself; and JSON `{ text, title? }` for text a client already holds. Which
 * parser reads the bytes is F§5.4's decision and never this route's: the bytes are the evidence, and
 * the declared type and the file name are hints, so an upload with the wrong name still reads as what
 * it is.
 *
 * Every refusal names the client's own failure. F§5.4's five codes answer with the statuses F§7.2
 * gives a parse — 415 for input no parser claims, 422 for a document Lectern could not read — and a
 * document that could not be fetched at all is `FETCH_REFUSED`, unless it was merely too large.
 *
 * The route is stateless: nothing it reads is written down, and a client that wants the document
 * again sends it again.
 */

import { FILENAME_HEADER, ParseJsonRequestSchema, type ParseResponse, ParseResponseSchema } from "@lectern/api-contract";
import { type ParseDocumentInput, type ParsedDocument, ParseError, type ParseErrorCode, parseDocument } from "@lectern/core/parsers";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config";
import type { HubContext } from "../context";
import { describeIssues, HubError } from "../errors";
import { FETCH_TIMEOUT_MS, FetchRefusedError, safeFetch } from "../fetch-url";

/**
 * The status each of F§5.4's five refusals answers with (F§7.2).
 *
 * Four of them are 422: the bytes are a document whose shape the hub recognised and whose contents it
 * could not read. `UNSUPPORTED_FORMAT` is 415, because there the input is a type no parser claims at
 * all. The hub's own table gives `PARSE_FAILED` 500, which is a status for a failure the hub owns; a
 * parse that failed on the document a client sent is the client's answer to read, so the status is
 * passed explicitly rather than taken from that table.
 */
const PARSE_STATUS: Record<ParseErrorCode, number> = {
  UNSUPPORTED_FORMAT: 415,
  INVALID_EPUB: 422,
  DRM_PROTECTED: 422,
  PARSE_FAILED: 422,
  EMPTY_DOCUMENT: 422,
};

/** F§7.1's upload limit in bytes: one parse body's size, and one fetched document's. */
export function maxUploadBytes(config: Config): number {
  return config.maxUploadMb * 1024 * 1024;
}

/** A request's own header as text: a header that arrived twice is neither a name nor a type. */
function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What one parse request asks the dispatcher to read, whichever of the three forms it arrived in. */
interface ParseRequest {
  bytes: Uint8Array;
  /** The type the client declared, or the type the fetched answer carried (F§5.4's middle hint). */
  mime?: string;
  /** F§7.2's `X-Lectern-Filename`: the name the bytes arrived under. */
  filename?: string;
  /** The address the bytes came from: F§5.1's `source.uri`, and `kind: "url"` for markup. */
  url?: string;
  /** The title the text form states explicitly (F§5.1's title rule prefers it). */
  title?: string;
  /** Whether these bytes could need F§5.5's OCR engine: false for text the route read itself. */
  mayNeedOcr: boolean;
}

/** The raw-bytes form: the body is the document itself, whatever type the request declares. */
function uploaded(request: FastifyRequest, config: Config, body: Uint8Array | string): ParseRequest {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const maxBytes = maxUploadBytes(config);
  if (bytes.length > maxBytes) {
    throw new HubError("PAYLOAD_TOO_LARGE", `the upload is larger than ${maxBytes} bytes (F§7.1's LECTERN_MAX_UPLOAD_MB)`);
  }
  const mime = headerOf(request, "content-type");
  const filename = headerOf(request, FILENAME_HEADER);
  return {
    bytes,
    mayNeedOcr: true,
    ...(mime === undefined ? {} : { mime }),
    ...(filename === undefined ? {} : { filename }),
  };
}

/** The JSON forms: an address for the hub to fetch, or text it reads where it stands. */
async function stated(body: unknown, config: Config): Promise<ParseRequest> {
  const parsed = ParseJsonRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new HubError("BAD_REQUEST", `the request body is not a parse request — ${describeIssues(parsed.error)}`);
  }
  const wanted = parsed.data;
  if (wanted.text !== undefined) {
    return {
      bytes: new TextEncoder().encode(wanted.text),
      mayNeedOcr: false,
      ...(wanted.title === undefined ? {} : { title: wanted.title }),
    };
  }
  const url = wanted.url;
  if (url === undefined) throw new HubError("BAD_REQUEST", "a parse request carries exactly one of `url` or `text` (F§7.2)");
  const fetched = await safeFetch(url, {
    maxBytes: maxUploadBytes(config),
    timeoutMs: FETCH_TIMEOUT_MS,
    allowPrivate: config.allowPrivateFetch,
  });
  return {
    bytes: fetched.bytes,
    url: fetched.finalUrl,
    mayNeedOcr: true,
    ...(fetched.mime === "" ? {} : { mime: fetched.mime }),
  };
}

/** The three forms, read from the body the parsers above left in the request. */
async function requestOf(request: FastifyRequest, config: Config): Promise<ParseRequest> {
  const body = request.body;
  if (body instanceof Uint8Array || typeof body === "string") return uploaded(request, config, body);
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return await stated(body, config);
  throw new HubError("BAD_REQUEST", "POST /v1/parse reads a file in the body, or JSON carrying `url` or `text` (F§7.2)");
}

/** F§5.4's own input for one request: the bytes, and only the hints the request actually carried. */
function dispatcherInput(wanted: ParseRequest): ParseDocumentInput {
  return {
    bytes: wanted.bytes,
    ...(wanted.mime === undefined ? {} : { mime: wanted.mime }),
    ...(wanted.filename === undefined ? {} : { filename: wanted.filename }),
    ...(wanted.url === undefined ? {} : { url: wanted.url }),
  };
}

/** F§7.2's failure for a parse: the code the failure carries, with the status this route gives it. */
function asHubError(cause: unknown): HubError {
  if (cause instanceof HubError) return cause;
  if (cause instanceof ParseError) return new HubError(cause.code, cause.message, PARSE_STATUS[cause.code]);
  if (cause instanceof FetchRefusedError) return new HubError(cause.code, cause.message);
  return new HubError("INTERNAL", "the hub could not read this document");
}

/**
 * The document one request asks for (F§5.4), with every failure translated on the way out.
 *
 * The OCR engine is asked for only when the bytes could need one — a text form never can — so a hub
 * that reads no image never builds the engine at all.
 */
async function parsedDocument(request: FastifyRequest, ctx: HubContext): Promise<ParsedDocument> {
  try {
    const wanted = await requestOf(request, ctx.config);
    const parsed = await parseDocument(dispatcherInput(wanted), wanted.mayNeedOcr ? { ocr: ctx.ocr() } : {});
    if (wanted.title === undefined) return parsed;
    // F§5.1's title rule prefers a title the caller states. The dispatcher's text branch has none to
    // pass to `buildDocument`, and the title is not part of `docId` (F§5.2 hashes the block texts
    // alone), so the stated title is stamped here — inside the call whose answer is validated below.
    return { ...parsed, document: { ...parsed.document, title: wanted.title } };
  } catch (cause) {
    throw asHubError(cause);
  }
}

export function parseRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.post("/v1/parse", async (request): Promise<ParseResponse> => {
    const parsed = await parsedDocument(request, ctx);
    return ParseResponseSchema.parse(
      parsed.anchors === undefined ? { document: parsed.document } : { document: parsed.document, anchors: parsed.anchors },
    );
  });
}
