/**
 * The WebSocket change feed (F§8.3): `GET /v1/sync/ws`.
 *
 * The feed carries no data — a `changed` message only tells a client that `rev` moved, and the client answers
 * it with an ordinary pull over the HTTP routes — so this module is small on purpose and owns four things:
 *
 * - **Authentication is a first message, never the address.** A socket has no header to carry F§11's bearer
 *   token, and F§8.3 forbids the token in the URL, a cookie or a subprotocol header, so a client's first
 *   message must be `{ "type": "auth", "token": "…" }` inside the configured `wsAuthTimeoutMs` (5 s by
 *   default). The comparison is the constant-time one the HTTP routes already use (U-019), so a guess cannot
 *   be read off the timing; every failure — a wrong token, a first message that is not an authentication, or
 *   silence past the deadline — closes the socket with `4401`.
 * - **`ready`, and then every `changed`.** The current `rev` is read and the change subscription is taken in
 *   one synchronous step, before `ready` goes out, so no commit can slip between the two unnoticed; F§8.2's
 *   `onChange` then sends `changed` with the new `rev` for every commit that moved it.
 * - **`ping`, and a socket that stops answering is closed.** A `ping` goes out every `wsPingIntervalMs` (30 s
 *   by default) and a `pong` clears the count; two pings may go unanswered before the socket is closed.
 * - **Every socket closes with the hub.** The server's own clients are closed by the plugin as the server
 *   stops; the sockets opened here are closed here as well, so a hub that shuts down leaves none of them open.
 *
 * A request to this path *without* an upgrade is not a socket at all and is answered `426 Upgrade Required`
 * through F§7.2's envelope, so a client that probed the path still parses one shape.
 */

import { ErrorBodySchema, WsClientMessageSchema, WsServerMessageSchema } from "@lectern/api-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { constantTimeEquals, WS_FEED_PATH } from "../auth";
import type { HubContext } from "../context";

/**
 * The slice of a `ws` socket this feed uses, declared here rather than imported from the plugin's
 * declarations: `@fastify/websocket`'s `types/index.d.ts` reaches `ws` and through it `@types/node`, whose
 * `Buffer` re-breaks two frozen `packages/core` parser lines in this program (the trap U-023 and U-055 each
 * measured). The four members below are the whole socket surface F§8.3's feed touches, and the plugin hands
 * one of its own sockets to `wsHandler`, so the object at runtime is the real thing.
 */
export interface FeedSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** The route options this module registers: F§8.3's path needs the plugin's `wsHandler` beside its handler. */
type FeedRouteOptions = RouteOptions & { wsHandler: (socket: FeedSocket) => void };

/** F§7.2's route table: the path this module owns, and the one path `auth.ts` exempts from its header check. */
export const SYNC_WS_PATH = WS_FEED_PATH;

/** F§8.3's close code for a socket that did not authenticate. */
export const WS_UNAUTHENTICATED_CODE = 4401;

/**
 * The close code for a socket that stopped answering pings. F§8.3 names no code for that case — only `4401`
 * for a failed authentication — so this hub uses the application code beside it.
 */
export const WS_NO_PONG_CODE = 4408;

/** How many pings may go unanswered before the socket is closed (F§8.3: "close after two unanswered pings"). */
export const MISSED_PINGS_BEFORE_CLOSE = 2;

/** What a request that did not ask to upgrade is answered with. */
const UPGRADE_REQUIRED = 426;

/** The reason a close frame carries is for a log; the code is what a client reads. */
const UNAUTHENTICATED_REASON = "the feed authenticates with a first auth message (F8.3)";
const NO_PONG_REASON = "two pings went unanswered (F8.3)";
const SHUTDOWN_REASON = "the hub is shutting down";
const NORMAL_CLOSURE = 1001;

/**
 * The text of one message frame. `ws` hands a message over as bytes, and a client of this feed speaks JSON,
 * so a frame that is not text at all reads as the empty string — which no message of F§8.3 parses as, and so
 * fails authentication rather than being answered.
 */
function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return "";
}

/**
 * The credential of an `auth` message, read beside the parsed envelope rather than out of it: U-054's
 * `WsClientMessageSchema` pins the `auth` discriminator and deliberately names no token, so the message is
 * validated by that schema and the string it carried is taken from the value the schema accepted.
 */
function tokenOf(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const token = (message as { token?: unknown }).token;
  return typeof token === "string" ? token : null;
}

/**
 * `syncWsRoutes(app, ctx)` — F§8.3's change feed on one path.
 *
 * The route is registered with a `wsHandler` beside an ordinary handler, which is what tells the two kinds of
 * request apart: an upgrade is handed to `feed`, and a plain HTTP GET — a probe, a health check, a client that
 * forgot to upgrade — reaches the handler and is refused. The plugin that owns the upgrade path is registered
 * by `app.ts`, before the route registry runs.
 */
export function syncWsRoutes(app: FastifyInstance, ctx: HubContext): void {
  /** Every socket this feed currently holds, so the hub can close them as it stops. */
  const live = new Set<FeedSocket>();

  /** One connection: its authentication, its ping clock and its subscription. */
  function feed(socket: FeedSocket): void {
    live.add(socket);
    let open = true;
    let authenticated = false;
    let missedPings = 0;
    let pingOutstanding = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let stopWatching: (() => void) | null = null;

    /** Send one message of F§8.3's server set, built through the contract's own schema. */
    function send(message: unknown): void {
      if (!open) return;
      socket.send(JSON.stringify(WsServerMessageSchema.parse(message)));
    }

    /** Close with a code the feed's clients read, unless the socket has already gone. */
    function closeWith(code: number, reason: string): void {
      if (!open) return;
      socket.close(code, reason);
    }

    /**
     * One turn of the ping clock. A ping that was not answered is counted first, so the second unanswered
     * ping closes the socket; a `pong` clears both the count and the outstanding ping.
     */
    function ping(): void {
      if (!open) return;
      if (pingOutstanding) {
        missedPings += 1;
        if (missedPings >= MISSED_PINGS_BEFORE_CLOSE) {
          closeWith(WS_NO_PONG_CODE, NO_PONG_REASON);
          return;
        }
      }
      pingOutstanding = true;
      send({ type: "ping" });
    }

    /** The deadline F§8.3 gives a socket to authenticate in. */
    const authTimer = setTimeout((): void => {
      if (!authenticated) closeWith(WS_UNAUTHENTICATED_CODE, UNAUTHENTICATED_REASON);
    }, ctx.config.wsAuthTimeoutMs);

    /** Take the feed over: the deadline is off, the pings start, and `ready` carries the current `rev`. */
    function startFeed(): void {
      authenticated = true;
      clearTimeout(authTimer);
      pingTimer = setInterval(ping, ctx.config.wsPingIntervalMs);
      stopWatching = ctx.records.onChange((rev: number): void => {
        send({ type: "changed", rev });
      });
      send({ type: "ready", rev: ctx.records.currentRev() });
    }

    socket.on("message", (data: unknown): void => {
      let value: unknown = null;
      try {
        value = JSON.parse(textOf(data)) as unknown;
      } catch {
        value = null;
      }
      const parsed = WsClientMessageSchema.safeParse(value);
      if (!authenticated) {
        const token = parsed.success && parsed.data.type === "auth" ? tokenOf(value) : null;
        if (token === null || !constantTimeEquals(token, ctx.config.token)) {
          closeWith(WS_UNAUTHENTICATED_CODE, UNAUTHENTICATED_REASON);
          return;
        }
        startFeed();
        return;
      }
      if (parsed.success && parsed.data.type === "pong") {
        missedPings = 0;
        pingOutstanding = false;
      }
    });

    socket.on("close", (): void => {
      open = false;
      live.delete(socket);
      clearTimeout(authTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      if (stopWatching !== null) stopWatching();
    });
  }

  app.route({
    method: "GET",
    url: SYNC_WS_PATH,
    // The path without an upgrade: F§7.2's envelope, with the status that names what the client must do.
    handler: (_request: FastifyRequest, reply: FastifyReply): void => {
      const message = `GET ${SYNC_WS_PATH} is a WebSocket endpoint (F§8.3): it is opened with an Upgrade header`;
      reply
        .code(UPGRADE_REQUIRED)
        .header("upgrade", "websocket")
        .send(ErrorBodySchema.parse({ error: { code: "BAD_REQUEST", message } }));
    },
    wsHandler: (socket: FeedSocket): void => {
      feed(socket);
    },
  } as FeedRouteOptions);

  app.addHook("onClose", (): void => {
    for (const socket of live) socket.close(NORMAL_CLOSURE, SHUTDOWN_REASON);
  });
}
