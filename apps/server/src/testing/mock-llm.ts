/**
 * The mock LLM server (F§9, P6): a `node:http` server answering `POST /chat/completions` the way an
 * OpenAI-compatible endpoint does, so every AI unit can be verified with no GPU, no model download and no
 * network. A test — or a route unit's own suite — starts it, points a provider at `baseUrl`, and steers the
 * reply with a marker in its prompt.
 *
 * The reply rules (F§9) are string searches over the user message, so a case chooses what the endpoint does by
 * writing its own prompt rather than by passing an argument: an invalid answer once, an invalid answer every
 * time, an HTTP 500, a two-second delay, a map step's notes, or a reduce step's result. What arrived is kept
 * in `requests`, so a case can assert the request the hub built rather than only what it got back.
 *
 * `node:http` is reached through a `string`-typed specifier rather than a static import, for the reason the
 * hub's own database module documents: a static `node:` import is `TS2591` in a package without Node's
 * ambient types, and R10 forbids installing them. The part of the host's API used here is declared below.
 */

import { z } from "zod";

/** The one route this mock answers (F§9). */
const COMPLETIONS_PATH = "/chat/completions";

/** The address the mock binds: a loopback port, so no case reaches anything but this machine. */
const LOOPBACK = "127.0.0.1";

/** The content type every answer carries. */
const CONTENT_TYPE = "application/json";

/** How long `FORCE_SLOW` makes a reply wait (F§9's reply rules). */
const SLOW_REPLY_MS = 2000;

/** How many words of a prompt a generated note or takeaway quotes. */
const QUOTED_WORDS = 6;

/** How many notes a map reply carries, and how many takeaways each mode's reduce reply carries (F§9). */
const MAP_NOTES = 3;
const BRIEF_TAKEAWAYS = 5;
const DETAILED_TAKEAWAYS = 9;

/** The four markers F§9's reply rules read in the user message. */
const FORCE_ERROR = "FORCE_ERROR";
const FORCE_INVALID = "FORCE_INVALID";
const FORCE_INVALID_ONCE = "FORCE_INVALID_ONCE";
const FORCE_SLOW = "FORCE_SLOW";

/** A reply that is deliberately not JSON, which is what F§9's two invalid markers ask for. */
const NOT_JSON = "this answer is deliberately not JSON";

/** One call the mock received, as a case reads it back. */
export interface MockLlmCall {
  method: string;
  path: string;
  /** The headers as they arrived, with their names lower-cased so a case need not know the case. */
  headers: Record<string, string>;
  /** The body parsed as JSON, or `null` when it was not JSON at all. */
  body: unknown;
}

/** The mock, as a case uses it: where it listens, what it saw, and how to stop it. */
export interface MockLlm {
  baseUrl: string;
  requests: MockLlmCall[];
  close(): Promise<void>;
}

/** The part of an OpenAI-compatible request this mock reads (F§9): the prompt messages. */
const ChatRequestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })).default([]),
});

/** What the mock answers with: the status, and the body it sends as JSON. */
interface MockReply {
  status: number;
  body: unknown;
}

/** One completion, as an OpenAI-compatible server sends it: the single choice carries the message's content. */
function completion(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

/** A body chunk as this mock reads it: text, which is all a JSON request body ever is. */
interface MockChunk {
  toString(): string;
}

/** The subset of `node:http`'s incoming message this mock uses. */
interface MockIncomingRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | undefined>;
  on(event: "data", listener: (chunk: MockChunk) => void): void;
  on(event: "end", listener: () => void): void;
}

/** The subset of `node:http`'s server response this mock uses. */
interface MockServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** The address a listening server reports. This mock only ever binds a TCP port. */
interface MockAddress {
  port: number;
}

/** The subset of `node:http`'s server this mock uses. */
interface MockHttpServer {
  listen(port: number, host: string, callback: () => void): unknown;
  address(): MockAddress | null;
  close(callback: () => void): unknown;
  closeAllConnections(): void;
}

/** What the `node:http` module offers this mock. */
interface MockHttpModule {
  createServer(handler: (request: MockIncomingRequest, response: MockServerResponse) => void): MockHttpServer;
}

/** `node:http`, reached by specifier when the mock starts. */
async function httpModule(): Promise<MockHttpModule> {
  const specifier: string = "node:http";
  return (await import(specifier)) as MockHttpModule;
}

/** A request body as JSON, or `null` when it is not JSON. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The headers a request carried, with their names lower-cased. */
function readHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = typeof value === "string" ? value : "";
  return result;
}

/** The user message's text, which is what every reply rule reads — the system message is not searched. */
function userTextOf(body: unknown): string {
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) return "";
  return parsed.data.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

/** The first few words of a prompt, which is what a generated note or takeaway is built from. */
function firstWords(text: string, count: number): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  return words.length === 0 ? "the segment" : words.slice(0, count).join(" ");
}

/** A prompt with everything but letters and digits removed, so `keyTakeaways` and `key takeaways` are one word. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * F§9's map reply: three notes built from the first words of the segment. The segment travels as the user
 * message, so that is what a note quotes.
 */
function mapReply(text: string): MockReply {
  const quoted = firstWords(text, QUOTED_WORDS);
  const notes = Array.from({ length: MAP_NOTES }, (_unused, index) => `Note ${index + 1} about ${quoted}.`);
  return { status: 200, body: completion(JSON.stringify({ notes })) };
}

/**
 * F§9's reduce reply, for the mode the prompt asks about: `brief` unless the prompt says `detailed`. Its
 * takeaway count is the one F§9's prompt asks for in each mode, so it also sits inside the validation range
 * the mode's result schema carries (3–6 for `brief`, 6–12 for `detailed`).
 */
function reduceReply(text: string): MockReply {
  const detailed = normalized(text).includes("detailed");
  const count = detailed ? DETAILED_TAKEAWAYS : BRIEF_TAKEAWAYS;
  const quoted = firstWords(text, QUOTED_WORDS);
  return {
    status: 200,
    body: completion(
      JSON.stringify({
        summary: `The notes about ${quoted} condense to ${count} takeaways.`,
        keyTakeaways: Array.from({ length: count }, (_unused, index) => `Takeaway ${index + 1} about ${quoted}.`),
      }),
    ),
  };
}

/**
 * F§9's reply rules for one prompt, and the count of `FORCE_INVALID_ONCE` prompts already served.
 *
 * A prompt that names F§9's reduce output (`keyTakeaways`, written with or without a space or a case) is a
 * reduce prompt; anything else is a map prompt.
 *
 * `FORCE_INVALID_ONCE` is identified by its marker rather than by the exact message, because F§9's own retry
 * appends the validation error to that same message: a key on the text would answer the retry invalidly too
 * and the marker could never do what the contract asks of it, which is to be invalid once and then valid.
 */
function replyFor(text: string, invalidOnceServed: number): MockReply {
  if (text.includes(FORCE_ERROR)) {
    return { status: 500, body: { error: { message: "the mock was asked to fail" } } };
  }
  if (text.includes(FORCE_INVALID_ONCE)) {
    return invalidOnceServed === 0 ? { status: 200, body: completion(NOT_JSON) } : replyFor(text.replace(FORCE_INVALID_ONCE, ""), 0);
  }
  if (text.includes(FORCE_INVALID)) return { status: 200, body: completion(NOT_JSON) };
  return normalized(text).includes("keytakeaways") ? reduceReply(text) : mapReply(text);
}

/**
 * `startMockLlm()` — the mock endpoint, listening on a loopback port the operating system chooses.
 *
 * The reply arrives as the JSON an OpenAI-compatible server would send, with the one choice carrying the
 * `content`. `FORCE_SLOW` delays the answer by two seconds without changing it, so a case can either wait or
 * let a provider's own deadline pass first. Only `POST /chat/completions` is answered; everything else is a
 * 404, and every request that arrives is recorded whether it was answered or not.
 */
export async function startMockLlm(): Promise<MockLlm> {
  const http = await httpModule();
  const requests: MockLlmCall[] = [];
  let invalidOnceServed = 0;

  const server = http.createServer((request: MockIncomingRequest, response: MockServerResponse) => {
    const method = request.method ?? "GET";
    const path = request.url ?? "";
    const headers = readHeaders(request.headers);
    let raw = "";
    request.on("data", (chunk: MockChunk) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      const body = parseJson(raw);
      requests.push({ method, path, headers, body });
      if (method !== "POST" || path !== COMPLETIONS_PATH) {
        response.writeHead(404, { "content-type": CONTENT_TYPE });
        response.end(JSON.stringify({ error: { message: `no route answers ${method} ${path}` } }));
        return;
      }
      const text = userTextOf(body);
      const reply = replyFor(text, invalidOnceServed);
      if (text.includes(FORCE_INVALID_ONCE)) invalidOnceServed += 1;
      const answer = (): void => {
        response.writeHead(reply.status, { "content-type": CONTENT_TYPE });
        response.end(JSON.stringify(reply.body));
      };
      if (text.includes(FORCE_SLOW)) setTimeout(answer, SLOW_REPLY_MS);
      else answer();
    });
  });

  await new Promise<void>((bound) => {
    server.listen(0, LOOPBACK, () => bound());
  });
  const address = server.address();
  const port = address === null ? 0 : address.port;

  return {
    baseUrl: `http://${LOOPBACK}:${port}`,
    requests,
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}
