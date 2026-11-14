/**
 * F§7.2's URL fetch, one rule at a time: the scheme allowlist, the address rule through an injected
 * resolver, the five-redirect limit, the deadline, and the size limit enforced while the bytes
 * arrive.
 *
 * Every case that needs a real answer runs against a stub on a loopback port, which is also why
 * `allowPrivate` is on wherever an answer has to arrive at all: without it a hub refuses to read from
 * `127.0.0.1`, which is exactly the rule the address cases are about.
 *
 * The stub's log of the requests it saw is the evidence that a refusal happened *before* a connection
 * was made, and that a redirect's address was judged rather than fetched.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "vitest";
import { FetchRefusedError, MAX_REDIRECTS, type SafeFetchOptions, safeFetch } from "../fetch-url";

/** The six addresses F§7.2 names by example, and the ones its checks have to refuse. */
const REFUSED_ADDRESSES = ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "::1", "fc00::1"] as const;

/** One request a stub answered: its path, and the two headers F§7.2 says must never travel. */
interface SeenRequest {
  path: string;
  authorization: string | undefined;
  cookie: string | undefined;
}

/** A stub's origin, the requests it answered, and how to stop it. */
interface Stub {
  origin: string;
  seen: SeenRequest[];
}

/** What one path of a stub answers with. A route that holds writes its first chunk and never ends. */
interface Route {
  status?: number;
  body?: string;
  contentType?: string;
  location?: string;
  /** Answer the headers and the body's first chunk, then stay open: a stalled or endless answer. */
  hold?: boolean;
  /** Answer nothing at all, and keep the connection open. */
  silent?: boolean;
}

/** A stub whose answers are a small table of paths. */
function stubFor(routes: Readonly<Record<string, Route>>): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const route = routes[request.url ?? ""];
    if (route === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (route.silent === true) return;
    const headers: Record<string, string> = {};
    if (route.contentType !== undefined) headers["content-type"] = route.contentType;
    if (route.location !== undefined) headers.location = route.location;
    response.writeHead(route.status ?? 200, headers);
    if (route.hold === true) {
      response.write(route.body ?? "");
      return;
    }
    response.end(route.body ?? "");
  };
}

/**
 * Run `body` against a stub on a loopback port, and stop the stub however the case ends.
 *
 * `host` picks which loopback address it answers on: `127.0.0.1` by default, and `::1` for the case
 * about a redirect that leaves the address the caller's URL led to — two addresses, one machine.
 */
async function withStub(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
  body: (stub: Stub) => Promise<void>,
  host = "127.0.0.1",
): Promise<void> {
  const seen: SeenRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push({ path: request.url ?? "", authorization: request.headers.authorization, cookie: request.headers.cookie });
    answer(request, response);
  });
  await new Promise<void>((ready) => server.listen(0, host, ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`the stub did not bind a port on ${host}`);
  const origin = host.includes(":") ? `http://[${host}]:${address.port}` : `http://${host}:${address.port}`;
  try {
    await body({ origin, seen });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/** What a fetch refused with, or a failure when it answered at all. */
async function refusalOf(url: string, options: Partial<SafeFetchOptions> = {}): Promise<FetchRefusedError> {
  const refusal = await safeFetch(url, { maxBytes: 4096, timeoutMs: 5000, allowPrivate: false, ...options }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(refusal).toBeInstanceOf(FetchRefusedError);
  if (!(refusal instanceof FetchRefusedError)) throw new Error(`expected ${url} to be refused`);
  return refusal;
}

/** The bytes of an answer as text, which is all these cases have to read. */
function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test("only http and https are fetched, and nothing else asks a resolver for anything", async () => {
  const asked: string[] = [];
  const lookup = async (host: string): Promise<{ address: string; family: number }[]> => {
    asked.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  for (const url of ["file:///etc/passwd", "ftp://example.test/notes.txt", "data:text/plain,hello", "ws://example.test/", "not a url"]) {
    expect((await refusalOf(url, { lookup })).code).toBe("FETCH_REFUSED");
  }
  expect(asked).toEqual([]);
});

test("every address F§7.2 names is refused through the resolver, with the address in the answer", async () => {
  for (const address of REFUSED_ADDRESSES) {
    const lookup = async (): Promise<{ address: string; family: number }[]> => [{ address, family: address.includes(":") ? 6 : 4 }];
    const refusal = await refusalOf("http://inside.example.test/notes", { lookup });
    expect(refusal.code).toBe("FETCH_REFUSED");
    expect(refusal.message).toContain(address);
    expect(refusal.message).toContain("LECTERN_ALLOW_PRIVATE_FETCH");
  }
});

test("a literal address is judged without asking the resolver, whichever form it is written in", async () => {
  let asked = 0;
  const lookup = async (): Promise<{ address: string; family: number }[]> => {
    asked += 1;
    return [];
  };
  for (const url of ["http://127.0.0.1/", "http://[::1]:8080/", "http://10.0.0.5/notes", "http://[::ffff:10.0.0.1]/"]) {
    expect((await refusalOf(url, { lookup })).code).toBe("FETCH_REFUSED");
  }
  expect(asked).toBe(0);
});

test("a loopback address is read when the operator allows it, and the bytes, the type and the address come back", async () => {
  const routes = { "/notes": { body: "Lighthouse Notes", contentType: "text/plain; charset=utf-8" } };
  await withStub(stubFor(routes), async (stub) => {
    const fetched = await safeFetch(`${stub.origin}/notes`, { maxBytes: 4096, timeoutMs: 5000, allowPrivate: true });
    expect(textOf(fetched.bytes)).toBe("Lighthouse Notes");
    expect(fetched.mime).toBe("text/plain; charset=utf-8");
    expect(fetched.finalUrl).toBe(`${stub.origin}/notes`);
  });
});

test("the request carries no credential the hub holds", async () => {
  await withStub(stubFor({ "/notes": { body: "hello" } }), async (stub) => {
    await safeFetch(`${stub.origin}/notes`, { maxBytes: 4096, timeoutMs: 5000, allowPrivate: true });
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]?.authorization).toBeUndefined();
    expect(stub.seen[0]?.cookie).toBeUndefined();
  });
});

test("a redirect that stays on the address the caller's URL led to is followed", async () => {
  const routes = { "/one": { status: 302, location: "/two" }, "/two": { body: "the second answer" } };
  await withStub(stubFor(routes), async (stub) => {
    const fetched = await safeFetch(`${stub.origin}/one`, { maxBytes: 4096, timeoutMs: 5000, allowPrivate: true });
    expect(textOf(fetched.bytes)).toBe("the second answer");
    expect(fetched.finalUrl).toBe(`${stub.origin}/two`);
    expect(stub.seen.map((entry) => entry.path)).toEqual(["/one", "/two"]);
  });
});

test("at most five redirects are followed", async () => {
  await withStub(stubFor({ "/loop": { status: 302, location: "/loop" } }), async (stub) => {
    const refusal = await refusalOf(`${stub.origin}/loop`, { allowPrivate: true });
    expect(refusal.code).toBe("FETCH_REFUSED");
    expect(stub.seen).toHaveLength(MAX_REDIRECTS + 1);
  });
});

test("a redirect to a local address the fetch did not start from is refused, and that address is never asked", async () => {
  await withStub(
    stubFor({ "/": { body: "never read" } }),
    async (target) => {
      await withStub(
        (_request, response) => {
          response.writeHead(302, { location: `${target.origin}/` });
          response.end();
        },
        async (stub) => {
          const refusal = await refusalOf(`${stub.origin}/go`, { allowPrivate: true });
          expect(refusal.code).toBe("FETCH_REFUSED");
          expect(refusal.message).toContain("::1");
          expect(stub.seen).toHaveLength(1);
          expect(target.seen).toEqual([]);
        },
      );
    },
    "::1",
  );
});

test("a redirect to a scheme the hub does not fetch is refused where it is named", async () => {
  await withStub(stubFor({ "/go": { status: 302, location: "file:///etc/passwd" } }), async (stub) => {
    const refusal = await refusalOf(`${stub.origin}/go`, { allowPrivate: true });
    expect(refusal.code).toBe("FETCH_REFUSED");
    expect(refusal.message).toContain("file:");
    expect(stub.seen).toHaveLength(1);
  });
});

test("a redirect's own host is resolved, and judged by the address it has", async () => {
  const asked: string[] = [];
  const lookup = async (host: string): Promise<{ address: string; family: number }[]> => {
    asked.push(host);
    return [{ address: "192.168.1.9", family: 4 }];
  };
  await withStub(stubFor({ "/go": { status: 302, location: "http://second.example.test/notes" } }), async (stub) => {
    const refusal = await refusalOf(`${stub.origin}/go`, { allowPrivate: true, lookup });
    expect(refusal.code).toBe("FETCH_REFUSED");
    expect(asked).toEqual(["second.example.test"]);
    expect(refusal.message).toContain("192.168.1.9");
    expect(stub.seen).toHaveLength(1);
  });
});

test("an address that stops answering is refused at the deadline rather than waited for", async () => {
  const routes = { "/silent": { silent: true }, "/stalled": { hold: true, body: "the beginning" } };
  await withStub(stubFor(routes), async (stub) => {
    for (const path of ["/silent", "/stalled"]) {
      const started = Date.now();
      const refusal = await refusalOf(`${stub.origin}${path}`, { allowPrivate: true, timeoutMs: 150 });
      expect(refusal.code).toBe("FETCH_REFUSED");
      expect(refusal.message).toContain("within 150 ms");
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });
});

test("an answer past the size limit is refused while it arrives, not after it has all arrived", async () => {
  const routes = { "/endless": { hold: true, body: "a".repeat(4096) } };
  await withStub(stubFor(routes), async (stub) => {
    const refusal = await refusalOf(`${stub.origin}/endless`, { allowPrivate: true, maxBytes: 1024, timeoutMs: 1000 });
    expect(refusal.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

test("an answer of exactly the limit is read", async () => {
  await withStub(stubFor({ "/exact": { body: "a".repeat(1024) } }), async (stub) => {
    const fetched = await safeFetch(`${stub.origin}/exact`, { maxBytes: 1024, timeoutMs: 5000, allowPrivate: true });
    expect(fetched.bytes.length).toBe(1024);
  });
});

test("a connection that cannot be made is refused with the transport's own reason", async () => {
  const refusal = await refusalOf("http://127.0.0.1:1/notes", { allowPrivate: true });
  expect(refusal.code).toBe("FETCH_REFUSED");
  expect(refusal.message).toContain("could not read");
});
