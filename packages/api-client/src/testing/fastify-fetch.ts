/**
 * A `fetch` over a Fastify instance (F§7.2): the hub's own `inject` behind the transport the client takes, so a
 * test drives the real hub — its routes, its authentication, its TTS cache — without a socket or a port.
 *
 * Bytes travel in both directions: a request body that is bytes reaches the route as those bytes, and the
 * answer's raw payload becomes the response's body, so an audio download is the same bytes the route served.
 * `content-length` is not copied, because the response sets it from the body it is given.
 *
 * The app is described by `InjectingApp` rather than by Fastify's own type: this package declares no dependency
 * on `fastify` (R10 names only the packages this unit installs), and a hub instance satisfies this interface
 * structurally. The adapter's domain is the two forms a client uses — a URL and an init — which is what the cast
 * to `typeof fetch` narrows the global signature to.
 */

/** One injected request, as `inject` takes it: the path, the method, the headers and the body. */
export interface InjectRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload?: string | Uint8Array;
}

/** What an injected answer carries: the status it answered with, its headers and its raw bytes. */
export interface InjectAnswer {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  rawPayload: Uint8Array;
}

/** The one capability this adapter needs of a hub app: a request answered without a socket. */
export interface InjectingApp {
  inject(options: InjectRequest): Promise<InjectAnswer>;
}

/** Response headers the answer sets for itself, and which a copied header would contradict. */
const UNSET_BY_RESPONSE = new Set(["content-length", "transfer-encoding"]);

/** The headers a caller may hand the adapter, in the forms `fetch` accepts, as one plain record. */
function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) record[name] = value;
    return record;
  }
  for (const [name, value] of Object.entries(headers)) record[name] = value;
  return record;
}

/** The Node `Buffer` factory the injector needs: `inject` JSON-encodes every payload that is not one. */
interface BufferFactory {
  from(bytes: Uint8Array): Uint8Array;
}

/** The factory, loaded once: the import below happens on the first byte payload and never again. */
let bufferFactory: BufferFactory | null = null;

/**
 * The bytes as the payload `inject` accepts.
 *
 * `inject` keeps a payload it recognises as bytes and JSON-encodes everything else — a plain `Uint8Array` is
 * not one of those (`light-my-request`'s `lib/request.js` tests `Buffer.isBuffer` before it decides), so the
 * bytes are converted here, at the one boundary where they enter the injector. The Node built-in is reached
 * through a specifier held in a variable, because the compiler resolves a dynamic import only when its
 * argument is a literal, and this workspace carries no `@types/node` (R10).
 */
async function bytesForInject(bytes: Uint8Array): Promise<Uint8Array> {
  if (bufferFactory === null) {
    const specifier: string = "node:buffer";
    bufferFactory = ((await import(specifier)) as { Buffer: BufferFactory }).Buffer;
  }
  return bufferFactory.from(bytes);
}

/** A request body as `inject` takes it: text as text, bytes as bytes, and anything else read into bytes. */
async function payloadOf(body: BodyInit | null | undefined): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return await bytesForInject(body);
  if (body instanceof ArrayBuffer) return await bytesForInject(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return await bytesForInject(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return await bytesForInject(new Uint8Array(await new Response(body).arrayBuffer()));
}

/** The path and query of an absolute URL: the part `inject` routes on. */
function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** An answer's headers, as the response should carry them. */
function answerHeaders(headers: Record<string, unknown>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || UNSET_BY_RESPONSE.has(name.toLowerCase())) continue;
    record[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return record;
}

/** `fetchFromFastify(app)` — a `fetch` that answers from `app.inject`, bytes and all. */
export function fetchFromFastify(app: InjectingApp): typeof fetch {
  const adapter = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const payload = await payloadOf(init?.body);
    const options: InjectRequest = {
      url: pathOf(input.toString()),
      method: init?.method ?? "GET",
      headers: headerRecord(init?.headers),
      ...(payload === undefined ? {} : { payload }),
    };
    const answer = await app.inject(options);
    // The copy gives the response body an `ArrayBuffer` of its own, which is the only backing `BodyInit` admits.
    return new Response(new Uint8Array(answer.rawPayload), { status: answer.statusCode, headers: answerHeaders(answer.headers) });
  };
  return adapter as unknown as typeof fetch;
}
