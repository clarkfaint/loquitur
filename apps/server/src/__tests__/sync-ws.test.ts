/**
 * Phase 5's change feed (U-057) driven over a real socket: the hub listens on an ephemeral port and every case
 * speaks to it with Node's own `WebSocket` client, because what this unit has to prove is wire behaviour —
 * first-message authentication, the 4401 close, the deadline, the ping — and `inject` cannot carry a socket.
 *
 * The hub is the real one: U-055's record repository over a temporary SQLite file, and U-056's push route for
 * the commit that moves `rev`. The two feed clocks come from the configuration (200 ms to authenticate, 20 ms
 * between pings), so each case is arithmetic rather than a race with the wall clock, and the token is sent
 * inside the socket where F§8.3 puts it — never in the address, a cookie or a subprotocol.
 *
 * `node:fs/promises`, `node:os` and `node:path` need Node's ambient types, which this repository deliberately
 * does not install (R10), so this file stays outside `apps/server`'s type-check program, whose test
 * directories are excluded: vitest erases types instead of checking them and runs the file as written.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorBodySchema, PushResponseSchema } from "@lectern/api-contract";
import type { Op } from "@lectern/core";
import type { FastifyInstance } from "fastify";
import { expect, test } from "vitest";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import { SYNC_WS_PATH } from "../routes/sync-ws";

/** F§7.1's token floor is 32 characters; this one clears it and appears nowhere else. */
const TOKEN = "lectern-hub-test-token-0123456789";

const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTHORIZATION, "content-type": "application/json" };

/** F§8.3's server message set, as a case reads it off the wire. */
type FeedMessage = { type: "ready"; rev: number } | { type: "changed"; rev: number } | { type: "ping" };

/** One client of the feed: the socket, what it has received, and how it was closed. */
interface FeedClient {
  socket: WebSocket;
  messages: FeedMessage[];
  closed: { code: number; reason: string } | null;
}

interface Hub {
  app: FastifyInstance;
  /** The address the app listens on: `http://127.0.0.1:<ephemeral port>`. */
  base: string;
  close(): Promise<void>;
}

/**
 * Build the hub over a temporary data directory and listen on an ephemeral port, then hand it to the case.
 * `close` is idempotent, so a case that shuts the hub down itself (to watch the sockets go) leaves the
 * cleanup with nothing to do.
 */
async function withHub(run: (hub: Hub) => Promise<void>, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-ws-"));
  const config = loadConfig({ LECTERN_TOKEN: TOKEN, LECTERN_DATA_DIR: dataDir, ...env });
  const app = await buildApp(config);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await run({ app, base, close });
  } finally {
    await close();
  }
}

/** Wait for a condition the feed's own clocks bring about, or fail rather than hang a case forever. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("the change feed did not reach the state this case waits for");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Open one client of the feed. `answerPings` makes it behave like F§8.3's client — a `pong` for every `ping`
 * — and the connection is complete only once the upgrade handshake has finished.
 */
async function connect(base: string, answerPings = false): Promise<FeedClient> {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}${SYNC_WS_PATH}`);
  const client: FeedClient = { socket, messages: [], closed: null };
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as FeedMessage;
    client.messages.push(message);
    if (answerPings && message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
  });
  socket.addEventListener("close", (event: CloseEvent) => {
    client.closed = { code: event.code, reason: event.reason };
  });
  await until(() => socket.readyState !== WebSocket.CONNECTING);
  if (socket.readyState !== WebSocket.OPEN) throw new Error(`the change feed's handshake did not complete (${socket.readyState})`);
  return client;
}

/** F§8.3's first message: the credential the hub compares in constant time. */
function authenticate(client: FeedClient, token: string = TOKEN): void {
  client.socket.send(JSON.stringify({ type: "auth", token }));
}

const pingCount = (client: FeedClient): number => client.messages.filter((message) => message.type === "ping").length;

/** One push of one `setting` op through U-056's route: the commit that moves `rev` (F§8.2). */
async function pushOneSetting(app: FastifyInstance, ts: number): Promise<number> {
  const op: Op = {
    opId: `ws-case-${ts}`,
    deviceId: "device-ws",
    entity: "setting",
    entityId: "theme",
    kind: "put",
    ts,
    record: { key: "theme", value: "dark", updatedAt: ts, deleted: false },
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: JSON_HEADERS,
    payload: { deviceId: "device-ws", ops: [op] },
  });
  expect(response.statusCode).toBe(200);
  return PushResponseSchema.parse(response.json() as unknown).rev;
}

test("a correct token receives ready with the hub's current rev, and no Authorization header was needed", async () => {
  await withHub(async ({ app, base }) => {
    // A commit first, so the `rev` the socket is told is the hub's current one rather than the trivial zero.
    const rev = await pushOneSetting(app, 1000);
    expect(rev).toBeGreaterThan(0);

    const client = await connect(base);
    authenticate(client);
    await until(() => client.messages.length > 0);
    expect(client.messages[0]).toEqual({ type: "ready", rev });
    expect(client.messages).toHaveLength(1);
    expect(client.closed).toBeNull();
  });
});

test("a wrong token is closed with 4401 and is told nothing", async () => {
  await withHub(async ({ base }) => {
    const client = await connect(base);
    authenticate(client, "n".repeat(TOKEN.length));
    await until(() => client.closed !== null);
    expect(client.closed?.code).toBe(4401);
    expect(client.messages).toEqual([]);
  });
});

test("a first message that is not an authentication is closed with 4401", async () => {
  await withHub(async ({ base }) => {
    const client = await connect(base);
    client.socket.send(JSON.stringify({ type: "pong" }));
    await until(() => client.closed !== null);
    expect(client.closed?.code).toBe(4401);
    expect(client.messages).toEqual([]);
  });
});

test("a socket that sends nothing is closed with 4401 once the authentication deadline passes", async () => {
  await withHub(
    async ({ base }) => {
      const client = await connect(base);
      await until(() => client.closed !== null);
      expect(client.closed?.code).toBe(4401);
      expect(client.messages).toEqual([]);
    },
    { LECTERN_WS_AUTH_TIMEOUT_MS: "200" },
  );
});

test("a push announces changed with the new rev to every connected socket", async () => {
  await withHub(async ({ app, base }) => {
    const first = await connect(base);
    const second = await connect(base);
    authenticate(first);
    authenticate(second);
    await until(() => first.messages.length === 1 && second.messages.length === 1);
    expect(first.messages[0]).toEqual({ type: "ready", rev: 0 });
    expect(second.messages[0]).toEqual({ type: "ready", rev: 0 });

    const firstRev = await pushOneSetting(app, 2000);
    await until(() => first.messages.length === 2 && second.messages.length === 2);
    expect(first.messages[1]).toEqual({ type: "changed", rev: firstRev });
    expect(second.messages[1]).toEqual({ type: "changed", rev: firstRev });

    // A second commit moves `rev` again: the subscription survives the message it just sent.
    const secondRev = await pushOneSetting(app, 3000);
    await until(() => first.messages.length === 3 && second.messages.length === 3);
    expect(secondRev).toBeGreaterThan(firstRev);
    expect(first.messages[2]).toEqual({ type: "changed", rev: secondRev });
    expect(second.messages[2]).toEqual({ type: "changed", rev: secondRev });
    expect(first.closed).toBeNull();
    expect(second.closed).toBeNull();
  });
});

test("a socket that never answers pings is closed after two of them", async () => {
  await withHub(
    async ({ base }) => {
      const client = await connect(base);
      authenticate(client);
      await until(() => pingCount(client) > 0);
      await until(() => client.closed !== null);
      expect(pingCount(client)).toBe(2);
      expect(client.closed?.code).toBe(4408);
    },
    { LECTERN_WS_PING_INTERVAL_MS: "20" },
  );
});

test("a socket that answers every ping is kept open and keeps being pinged", async () => {
  await withHub(
    async ({ base }) => {
      const client = await connect(base, true);
      authenticate(client);
      await until(() => pingCount(client) >= 3);
      expect(client.closed).toBeNull();
      expect(client.messages).toContainEqual({ type: "ready", rev: 0 });
    },
    { LECTERN_WS_PING_INTERVAL_MS: "20" },
  );
});

test("an HTTP request to the path without an upgrade is refused with 426 in the hub's own envelope", async () => {
  await withHub(async ({ app }) => {
    const response = await app.inject({ method: "GET", url: SYNC_WS_PATH });
    expect(response.statusCode).toBe(426);
    expect(response.headers.upgrade).toBe("websocket");
    expect(ErrorBodySchema.parse(response.json() as unknown).error.code).toBe("BAD_REQUEST");
  });
});

test("every socket is closed when the hub shuts down", async () => {
  await withHub(async ({ base, close }) => {
    const first = await connect(base);
    const second = await connect(base);
    authenticate(first);
    authenticate(second);
    await until(() => first.messages.length === 1 && second.messages.length === 1);

    await close();
    await until(() => first.closed !== null && second.closed !== null);
    expect(first.socket.readyState).toBe(WebSocket.CLOSED);
    expect(second.socket.readyState).toBe(WebSocket.CLOSED);
  });
});
