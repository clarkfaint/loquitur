/**
 * Reading a document from an address (F§7.2): `safeFetch`.
 *
 * F§7.2 gives a URL fetch four rules and this module keeps all four in one place: only `http:` and
 * `https:` are fetched, at most five redirects are followed, the size limit is enforced while the
 * bytes arrive, and the whole exchange runs under a deadline. The address rule is why this is not a
 * one-liner — a host is judged by the addresses its name resolves to rather than by the name, and the
 * judgement is made again at every hop, so a public page that redirects to `127.0.0.1` cannot reach
 * the hub's own network through it. The one exception is the address the caller's own URL led to,
 * which is what keeps `LECTERN_ALLOW_PRIVATE_FETCH=1` useful for a service that moves a path.
 *
 * A site the hub fetches is a stranger: the request carries no `authorization` and no `cookie`
 * header, because the hub's bearer token is the operator's and no fetched page has business seeing
 * it. The answer is read as bytes and never as code.
 *
 * The resolver is an option rather than a host global, so a test can say what addresses a name has
 * without owning a name; the transport is the platform's own `fetch`, which is the transport the
 * shipped hub uses.
 */

import { messageOf } from "./errors";

/** How many redirects F§7.2 lets one fetch follow. */
export const MAX_REDIRECTS = 5;

/** F§7.2's deadline for one URL fetch, in milliseconds. */
export const FETCH_TIMEOUT_MS = 20_000;

/** The statuses that ask a client to look somewhere else, and so may carry a `location`. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The only schemes F§7.2 fetches. `file:`, `ftp:` and `data:` are refused before any socket opens. */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** The one header this module's request carries (F§7.2's "no credential travels with a fetch"). */
const ACCEPT = "*/*";

/** The codes a refused fetch answers with (F§7.2): an address the hub will not read, or one too big. */
export type FetchRefusalCode = "FETCH_REFUSED" | "PAYLOAD_TOO_LARGE";

/** A fetch the hub will not make, with the code F§7.2 gives the reason. */
export class FetchRefusedError extends Error {
  readonly code: FetchRefusalCode;

  constructor(code: FetchRefusalCode, message: string) {
    super(message);
    this.name = "FetchRefusedError";
    this.code = code;
  }
}

/** One address a host name resolved to. `family` is 4 or 6, as the host's resolver reports it. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** F§7.2's injectable resolver: the addresses a host name has. */
export type HostLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** What a caller may say about one fetch. */
export interface SafeFetchOptions {
  /** The largest answer this fetch will read, in bytes (F§7.1's upload limit). */
  maxBytes: number;
  /** How long the whole exchange — redirects included — may take. */
  timeoutMs: number;
  /** Whether the caller's own URL may be a loopback, link-local or private address (F§7.1's flag). */
  allowPrivate: boolean;
  /** The resolver to ask instead of the host's, so a test can name the addresses a name has. */
  lookup?: HostLookup;
}

/** What a fetch hands back: the bytes, the type the answer declared, and where it finally came from. */
export interface FetchedDocument {
  bytes: Uint8Array;
  /** The answer's `Content-Type`, or `""` when it declared none: a hint for F§5.4, never evidence. */
  mime: string;
  /** The address the bytes were read from, after every redirect (F§5.1's `source.uri`). */
  finalUrl: string;
}

/**
 * Why an address is not one this hub reads from, or `undefined` when it is an ordinary public one.
 *
 * `local` is the group F§7.2's flag can open: the private networks, loopback and link-local, which an
 * operator may genuinely serve documents from. `unusable` is the group no flag opens, because these
 * addresses are no host at all: the unspecified address, multicast, and the reserved ranges nothing
 * answers from. Following a name to one of those is never what a reader meant.
 */
type AddressRefusal = "local" | "unusable";

/** The eight groups of an IPv6 address, or `null` when the text is not one. */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string): number[] | null => {
    if (half === "") return [];
    const parsed: number[] = [];
    for (const group of half.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };
  const head = groups(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = groups(halves[1] ?? "");
  if (tail === null) return null;
  const compressed = 8 - head.length - tail.length;
  if (compressed < 1) return null;
  return [...head, ...new Array<number>(compressed).fill(0), ...tail];
}

/** Two IPv6 groups as the IPv4 address their 32 bits spell. */
function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** The IPv4 address an IPv6 text embeds (`::ffff:1.2.3.4`, `::1.2.3.4`, `64:ff9b::1.2.3.4`). */
function embeddedIpv4(text: string): string | undefined {
  const last = text.slice(text.lastIndexOf(":") + 1);
  return last.includes(".") ? last : undefined;
}

/** Why an IPv4 address is not read from, or `undefined` when it is public. */
function refusalOfIpv4(text: string): AddressRefusal | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return "unusable";
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((number) => !Number.isInteger(number) || number < 0 || number > 255)) return "unusable";
  const [first = 0, second = 0] = numbers;
  if (first === 0 || first >= 224) return "unusable";
  if (first === 10 || first === 127) return "local";
  if (first === 169 && second === 254) return "local";
  if (first === 172 && second >= 16 && second <= 31) return "local";
  if (first === 192 && second === 168) return "local";
  if (first === 100 && second >= 64 && second <= 127) return "local";
  return undefined;
}

/** Why an IPv6 address is not read from, or `undefined` when it is public (F§7.2). */
function refusalOfIpv6(text: string): AddressRefusal | undefined {
  const withoutZone = text.split("%")[0] ?? "";
  const embedded = embeddedIpv4(withoutZone);
  if (embedded !== undefined) return refusalOfIpv4(embedded);
  const groups = ipv6Groups(withoutZone);
  if (groups === null) return "unusable";
  const first = groups[0] ?? 0;
  if (groups.every((group) => group === 0)) return "unusable";
  if ((first & 0xffc0) === 0xfe80) return "local";
  if ((first & 0xfe00) === 0xfc00) return "local";
  if ((first & 0xff00) === 0xff00) return "unusable";
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) === 1) return "local";
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] ?? 0) === 0xffff) {
    return refusalOfIpv4(ipv4FromGroups(groups[6] ?? 0, groups[7] ?? 0));
  }
  return undefined;
}

/** Why an address is not read from, whichever family it belongs to (F§7.2). */
function refusalOfAddress(address: string): AddressRefusal | undefined {
  return address.includes(":") ? refusalOfIpv6(address) : refusalOfIpv4(address);
}

/** Whether a host name is already an address, in which case no resolver is asked. */
function isAddress(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** A URL's host as an address: the brackets an IPv6 literal is written in are not part of it. */
function hostOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The subset of the host's DNS module this module reads, described here because nothing declares it. */
interface HostResolver {
  lookup(hostname: string, options: { all: true }): Promise<ResolvedAddress[]>;
}

/**
 * The host's own resolver, reached by specifier when it is first needed. The specifier is held in a
 * `string`-typed variable so the compiler does not try to resolve the built-in it names; at run time
 * the same module is the one Node, `tsx` and vitest all load, so the shipped behaviour is the
 * behaviour the tests exercise.
 */
async function resolverOfHost(): Promise<HostResolver> {
  const specifier: string = "node:dns/promises";
  return (await import(specifier)) as HostResolver;
}

/** Every address a host name has, or F§7.2's refusal when the name does not resolve. */
async function addressesOf(host: string, lookup: HostLookup | undefined): Promise<string[]> {
  const resolve = lookup ?? (async (name: string) => await (await resolverOfHost()).lookup(name, { all: true }));
  let answers: readonly ResolvedAddress[];
  try {
    answers = await resolve(host);
  } catch (cause) {
    throw new FetchRefusedError("FETCH_REFUSED", `the host name ${host} does not resolve — ${messageOf(cause)}`);
  }
  if (answers.length === 0) throw new FetchRefusedError("FETCH_REFUSED", `the host name ${host} resolves to no address`);
  return answers.map((answer) => answer.address);
}

/**
 * The address rule (F§7.2), judged before every hop: every address a host has must be one the hub
 * reads from. The addresses it accepted are handed back, so the next hop can be compared against them.
 *
 * The exception belongs to the addresses the caller's own URL led to. An operator turns
 * `LECTERN_ALLOW_PRIVATE_FETCH` on to point Lectern at a service of their own and knows what they
 * asked for, so that URL's addresses are opened by the flag; the address a *redirect* selects was
 * chosen by the fetched page instead — a document's links are written by whoever wrote the document —
 * and so a redirect may only stay where the caller's URL already was (a path that moved, or http to
 * https, on the operator's own service) and never reach the rest of the local network.
 */
async function assertReadable(url: URL, hop: number, accepted: ReadonlySet<string>, options: SafeFetchOptions): Promise<string[]> {
  const host = hostOf(url);
  const addresses = isAddress(host) ? [host] : await addressesOf(host, options.lookup);
  for (const address of addresses) {
    const refusal = refusalOfAddress(address);
    if (refusal === undefined) continue;
    if (refusal === "local" && (hop === 0 ? options.allowPrivate : accepted.has(address))) continue;
    const reason =
      refusal === "unusable"
        ? "is not an address a host answers from"
        : hop === 0
          ? "is a local address, and F§7.2 fetches from one only when LECTERN_ALLOW_PRIVATE_FETCH=1"
          : "is a local address, and a redirect reaches the local network only where the caller's own URL led";
    throw new FetchRefusedError("FETCH_REFUSED", `${url.href} resolves to ${address}, which ${reason}`);
  }
  return addresses;
}

/** The URL a fetch starts from, or from a `location` a redirect named. */
function targetOf(text: string, describedAs: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FetchRefusedError("FETCH_REFUSED", `${describedAs} ${JSON.stringify(text)} is not an absolute URL`);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new FetchRefusedError("FETCH_REFUSED", `${describedAs} ${url.href} uses ${url.protocol}, and F§7.2 fetches http and https only`);
  }
  return url;
}

/** The address a redirect asks for, resolved against the answer that named it. */
function redirectTarget(location: string, from: URL): URL {
  let resolved: string;
  try {
    resolved = new URL(location, from).href;
  } catch {
    throw new FetchRefusedError("FETCH_REFUSED", `${from.href} redirects to ${JSON.stringify(location)}, which is not a URL`);
  }
  return targetOf(resolved, `the redirect from ${from.href}`);
}

/** One request, with the redirect left to the caller so every hop can be judged before it is made. */
async function request(target: URL, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(target, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { accept: ACCEPT },
      signal,
    });
  } catch (cause) {
    throw new FetchRefusedError("FETCH_REFUSED", `the hub could not read ${target.href} — ${messageOf(cause)}`);
  }
}

/** Every chunk of an answer as one byte array. */
function join(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Let a body go, so a refused answer does not leave its socket open. */
async function release(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The connection is already gone; the refusal this call is making is the answer either way.
  }
}

/**
 * The bytes of an answer, counted as they arrive (F§7.2's size limit).
 *
 * The limit is enforced on the way in rather than on the whole body at once, so an endless answer
 * costs the reader the limit and no more: the body is let go the moment it is past it.
 */
async function readLimited(response: Response, maxBytes: number, target: URL): Promise<Uint8Array> {
  const tooLarge = (): FetchRefusedError =>
    new FetchRefusedError("PAYLOAD_TOO_LARGE", `${target.href} answers with more than ${maxBytes} bytes (F§7.1's limit)`);
  const body = response.body;
  if (body === null) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw tooLarge();
    return whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (cause) {
    await release(reader);
    throw cause;
  }
  return join(chunks, total);
}

/**
 * `withDeadline(task, timeoutMs, onExpire)` — F§7.2's timeout.
 *
 * The hub aborts the request it is waiting on and answers at the deadline whether or not the abort
 * took effect: a transport that ignored the signal would otherwise hold a reader open forever.
 */
function withDeadline<T>(task: Promise<T>, timeoutMs: number, onExpire: () => void): Promise<T> {
  return new Promise<T>((settle, refuse) => {
    const timer = setTimeout(() => {
      onExpire();
      refuse(new FetchRefusedError("FETCH_REFUSED", `the address did not answer within ${timeoutMs} ms (F§7.2)`));
    }, timeoutMs);
    void task.then(
      (value) => {
        clearTimeout(timer);
        settle(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        refuse(cause);
      },
    );
  });
}

/** Follow a redirect chain, judging every hop before it is fetched (F§7.2). */
async function follow(start: URL, options: SafeFetchOptions, signal: AbortSignal): Promise<FetchedDocument> {
  const accepted = new Set<string>();
  let target = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    for (const address of await assertReadable(target, hop, accepted, options)) accepted.add(address);
    const response = await request(target, signal);
    const location = response.headers.get("location");
    if (REDIRECT_STATUSES.has(response.status) && location !== null) {
      target = redirectTarget(location, target);
      continue;
    }
    const bytes = await readLimited(response, options.maxBytes, target);
    return { bytes, mime: response.headers.get("content-type") ?? "", finalUrl: target.href };
  }
  throw new FetchRefusedError("FETCH_REFUSED", `${start.href} redirects more than ${MAX_REDIRECTS} times (F§7.2)`);
}

/**
 * `safeFetch(url, options)` — the bytes at an address, or F§7.2's refusal.
 *
 * The answer is the bytes, the type the answer declared and the address they were finally read from;
 * a refusal is a `FetchRefusedError` carrying `FETCH_REFUSED` (the scheme, the address, the redirect
 * chain, the deadline, or a transport that failed) or `PAYLOAD_TOO_LARGE` (the size limit).
 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<FetchedDocument> {
  const start = targetOf(url, "the address");
  const controller = new AbortController();
  return await withDeadline(follow(start, options, controller.signal), options.timeoutMs, () => controller.abort());
}
