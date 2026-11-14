/**
 * `POST /v1/parse` (F§7.2) end to end through `inject`: every fixture as the body of a request, the
 * three forms of the route, and the status each refusal answers with.
 *
 * The hub is the real one — the real dispatcher, and the real tesseract.js engine behind the image
 * and the scan — because whether a scan yields text at all is a property of that engine. The data
 * directory is a temporary one, which is also where the engine caches its language data (F§5.5).
 *
 * Reading the fixtures needs `node:fs`, and the URL form needs a stub server, so this file stays
 * outside the package's type-check program (its test directories are excluded): vitest erases types
 * instead of checking them and runs it as written.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorBodySchema, type ParseResponse, ParseResponseSchema } from "@lectern/api-contract";
import type { FastifyInstance, InjectOptions } from "fastify";
import { expect, test } from "vitest";
import { z } from "zod";
import { buildApp } from "../app";
import { loadConfig } from "../config";

const require = createRequire(import.meta.url);

/** Every artefact U-005 generated for the parsers, by the name it is committed under. */
const FIXTURE_NAMES = ["sample.txt", "sample.md", "article.html", "text.pdf", "page.png", "scanned.pdf", "book.epub", "doc.docx"] as const;

type FixtureName = (typeof FIXTURE_NAMES)[number];

/** The source kind F§5.4's dispatcher must answer for each artefact. */
const FIXTURE_KINDS: Readonly<Record<FixtureName, string>> = {
  "sample.txt": "txt",
  "sample.md": "txt",
  "article.html": "html",
  "text.pdf": "pdf",
  "page.png": "ocr",
  "scanned.pdf": "pdf",
  "book.epub": "epub",
  "doc.docx": "docx",
};

/** The fixtures that name themselves in their own text (F§5.4); a scan has no title to declare. */
const TITLED_NAMES = ["sample.txt", "sample.md", "article.html", "text.pdf", "book.epub", "doc.docx"] as const;

/** The fixture's own bytes, read from the package's devDependency on first use. */
function fixtureBytes(name: FixtureName): Uint8Array {
  return new Uint8Array(readFileSync(require.resolve(`@lectern/fixtures/generated/${name}`)));
}

/** The fields of `expected.json` this file reads; the fixture carries more. */
const ExpectationsSchema = z.object({ title: z.string(), pageImageWords: z.array(z.string()) });

const EXPECTED = ExpectationsSchema.parse(JSON.parse(readFileSync(require.resolve("@lectern/fixtures/generated/expected.json"), "utf8")));

/** F§7.1's token floor is 32 characters; this one appears nowhere else. */
const TOKEN = "lectern-hub-test-token-0123456789";

const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };

/** F§5.5's declaration test allows one engine 120 s; reading three pages takes a small part of it. */
const TIMEOUT_MS = 120_000;

/** Bytes that are not a document and not UTF-8 either: a lead byte followed by a non-continuation. */
const NOT_UTF8 = new Uint8Array([0xc3, 0x28, 0x81, 0xff, 0x00, 0x80]);

/** UTF-8 text, as a client of the text form would hold it. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The hub a case runs against, and the data directory it was given. */
interface Hub {
  app: FastifyInstance;
  dataDir: string;
}

/**
 * Build the hub over a temporary data directory, and close it afterwards.
 *
 * The upload limit is one megabyte so the size case is exercised with a small body, and private
 * fetches are allowed because every stub in this file is on a loopback port; a case that is about
 * that flag passes `LECTERN_ALLOW_PRIVATE_FETCH: "0"` to turn it off again.
 */
async function withHub(body: (hub: Hub) => Promise<void>, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "lectern-parse-"));
  const config = loadConfig({
    LECTERN_TOKEN: TOKEN,
    LECTERN_DATA_DIR: dataDir,
    LECTERN_MAX_UPLOAD_MB: "1",
    LECTERN_ALLOW_PRIVATE_FETCH: "1",
    ...env,
  });
  const app = await buildApp(config);
  try {
    await body({ app, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** One upload of F§7.2's raw-body form: the bytes, the type the client declares, and the name. */
function upload(name: string, bytes: Uint8Array, contentType = "application/octet-stream") {
  return {
    method: "POST" as const,
    url: "/v1/parse",
    headers: { ...AUTHORIZATION, "content-type": contentType, "x-lectern-filename": name },
    payload: Buffer.from(bytes),
  };
}

/** One JSON request of F§7.2's stated forms. */
function statedRequest(payload: unknown) {
  return { method: "POST" as const, url: "/v1/parse", headers: { ...AUTHORIZATION, "content-type": "application/json" }, payload };
}

/** The document one request asks for, through the contract's own answer schema. */
async function parsedDocument(app: FastifyInstance, request: InjectOptions): Promise<ParseResponse> {
  const response = await app.inject(request);
  expect(response.statusCode).toBe(200);
  return ParseResponseSchema.parse(response.json() as unknown);
}

/** The refusal one request answers with: its status, and the code F§7.2 names in the envelope. */
async function refusalOf(app: FastifyInstance, request: InjectOptions): Promise<{ status: number; code: string; message: string }> {
  const response = await app.inject(request);
  const body = ErrorBodySchema.parse(response.json() as unknown);
  return { status: response.statusCode, code: body.error.code, message: body.error.message };
}

/** Run a case against a stub page server, and stop it afterwards. */
async function withStub(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
  body: (origin: string, seen: string[]) => Promise<void>,
  host = "127.0.0.1",
): Promise<void> {
  const seen: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push(`${request.method ?? "GET"} ${request.url ?? "/"} auth=${request.headers.authorization ?? "none"}`);
    answer(request, response);
  });
  await new Promise<void>((ready) => server.listen(0, host, ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`the stub did not bind a port on ${host}`);
  const origin = host.includes(":") ? `http://[${host}]:${address.port}` : `http://${host}:${address.port}`;
  try {
    await body(origin, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test(
  "every fixture uploads to a schema-valid document, and its bytes decide the format",
  async () => {
    await withHub(async ({ app }) => {
      const titles: Record<string, string> = {};
      for (const name of FIXTURE_NAMES) {
        const parsed = await parsedDocument(app, upload(name, fixtureBytes(name)));
        expect(parsed.document.source.kind).toBe(FIXTURE_KINDS[name]);
        expect(parsed.document.blocks.length).toBeGreaterThan(0);
        expect(parsed.document.wordCount).toBeGreaterThan(0);
        titles[name] = parsed.document.title;
      }
      for (const name of TITLED_NAMES) expect(titles[name]).toBe(EXPECTED.title);
      // A scan declares no title of its own: F§5.1's fallback names it after its first line, which for
      // the image is the document's own heading as the engine read it back.
      expect(titles["page.png"]?.startsWith(EXPECTED.title)).toBe(true);
      expect(titles["scanned.pdf"]?.length).toBe(60);
    });
  },
  TIMEOUT_MS,
);

test(
  "the image and the scan are read by F§5.5's engine, and the words come back",
  async () => {
    await withHub(async ({ app }) => {
      const image = await parsedDocument(app, upload("page.png", fixtureBytes("page.png")));
      expect(image.document.source.kind).toBe("ocr");
      expect(image.document.source.mime).toBe("image/png");
      expect(image.anchors).toBeUndefined();
      const read = image.document.blocks
        .flatMap((block) => block.sentences)
        .flatMap((sentence) => sentence.words)
        .map((word) => word.text.toLowerCase().replaceAll(/[^a-z0-9]/g, ""));
      const expected = EXPECTED.pageImageWords.map((word) => word.toLowerCase().replaceAll(/[^a-z0-9]/g, ""));
      // Measured on this host: 181 of the 181 words the fixture's own page holds come back, so the
      // floor below leaves room for the engine without testing its accuracy instead of the wiring.
      const found = expected.filter((word) => read.includes(word));
      expect(found.length).toBeGreaterThanOrEqual(175);

      const scan = await parsedDocument(app, upload("scanned.pdf", fixtureBytes("scanned.pdf")));
      expect(scan.document.source.kind).toBe("pdf");
      expect(scan.document.source.pageCount).toBe(2);
      expect(scan.anchors).toEqual([]);
      // Measured: both scanned pages together read back as 359 words in 2 blocks.
      expect(scan.document.wordCount).toBeGreaterThanOrEqual(300);
      expect(scan.document.blocks.length).toBe(2);
    });
  },
  TIMEOUT_MS,
);

test("text.pdf comes back with one anchor for every word", async () => {
  await withHub(async ({ app }) => {
    const parsed = await parsedDocument(app, upload("text.pdf", fixtureBytes("text.pdf")));
    expect(parsed.document.source.pageCount).toBe(5);
    expect(parsed.anchors?.length).toBe(parsed.document.wordCount);
  });
});

test("a declared type the bytes contradict does not change what the document is", async () => {
  await withHub(async ({ app }) => {
    const parsed = await parsedDocument(app, upload("text.pdf", fixtureBytes("text.pdf"), "text/plain"));
    expect(parsed.document.source.kind).toBe("pdf");
    expect(parsed.document.source.mime).toBe("application/pdf");
  });
});

test("the file name F§7.2's header carries is a hint the dispatcher can use", async () => {
  await withHub(async ({ app }) => {
    const fragment = utf8("<p>Markup that is not a whole page.</p>");
    expect((await parsedDocument(app, upload("page.html", fragment))).document.source.kind).toBe("html");
    expect((await parsedDocument(app, upload("", fragment))).document.source.kind).toBe("txt");
  });
});

test("the text form reads the text it is given, and follows F§5.1's and F§5.2's rules for it", async () => {
  await withHub(async ({ app }) => {
    const plain = await parsedDocument(app, statedRequest({ text: "Hello, world." }));
    expect(plain.document.docId).toBe("f8c3bf62a9aa3e6fc1619c250e48abe7");
    expect(plain.document.title).toBe("Hello, world.");
    expect(plain.document.source.kind).toBe("txt");
    expect(plain.document.sentenceCount).toBe(1);
    expect(plain.document.wordCount).toBe(2);
    expect(plain.anchors).toBeUndefined();

    const titled = await parsedDocument(app, statedRequest({ text: "# The Modern Lamp\n\nIt burned driftwood.", title: "Notes" }));
    expect(titled.document.title).toBe("Notes");
    const heading = titled.document.blocks[0];
    expect(heading).toBeDefined();
    expect(heading?.kind).toBe("heading");
  });
});

test("the url form fetches the page itself and records the address it came from", async () => {
  await withStub(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(fixtureBytes("article.html"));
    },
    async (origin, seen) => {
      await withHub(async ({ app }) => {
        const parsed = await parsedDocument(app, statedRequest({ url: `${origin}/article.html` }));
        expect(parsed.document.source.kind).toBe("url");
        expect(parsed.document.source.uri).toBe(`${origin}/article.html`);
        expect(parsed.document.source.mime).toBe("text/html");
        expect(parsed.document.title).toBe(EXPECTED.title);
        expect(parsed.document.wordCount).toBeGreaterThan(0);
        expect(seen).toEqual([`GET /article.html auth=none`]);
      });
    },
  );
});

test("the url form is refused with FETCH_REFUSED when the operator has not allowed private addresses", async () => {
  await withStub(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(fixtureBytes("article.html"));
    },
    async (origin, seen) => {
      await withHub(
        async ({ app }) => {
          const refusal = await refusalOf(app, statedRequest({ url: `${origin}/article.html` }));
          expect(refusal.status).toBe(400);
          expect(refusal.code).toBe("FETCH_REFUSED");
          expect(refusal.message).toContain("LECTERN_ALLOW_PRIVATE_FETCH");
          expect(seen).toEqual([]);
        },
        { LECTERN_ALLOW_PRIVATE_FETCH: "0" },
      );
    },
  );
});

test("a redirect to a local address the URL did not come from is refused, and that address is never asked", async () => {
  await withStub(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("never read");
    },
    async (targetOrigin, targetSeen) => {
      await withStub(
        (_request, response) => {
          response.writeHead(302, { location: `${targetOrigin}/` });
          response.end();
        },
        async (origin) => {
          await withHub(async ({ app }) => {
            const refusal = await refusalOf(app, statedRequest({ url: `${origin}/go` }));
            expect(refusal.status).toBe(400);
            expect(refusal.code).toBe("FETCH_REFUSED");
            expect(refusal.message).toContain("::1");
            expect(targetSeen).toEqual([]);
          });
        },
      );
    },
    "::1",
  );
});

test("a body past F§7.1's upload limit is refused with 413 before a parser sees it", async () => {
  await withHub(async ({ app }) => {
    const refusal = await refusalOf(app, upload("huge.bin", new Uint8Array(1_100_000)));
    expect(refusal.status).toBe(413);
    expect(refusal.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

test("bytes that are no document Lectern reads are refused with 415", async () => {
  await withHub(async ({ app }) => {
    const refusal = await refusalOf(app, upload("random.bin", NOT_UTF8));
    expect(refusal.status).toBe(415);
    expect(refusal.code).toBe("UNSUPPORTED_FORMAT");
  });
});

test("a document with no text is refused with 422", async () => {
  await withHub(async ({ app }) => {
    const refusal = await refusalOf(app, upload("blank.txt", utf8("   \n\n\t\n")));
    expect(refusal.status).toBe(422);
    expect(refusal.code).toBe("EMPTY_DOCUMENT");
  });
});

test("a JSON body that is neither an address nor text is refused with 400", async () => {
  await withHub(async ({ app }) => {
    for (const payload of [{ url: "https://example.test/", text: "both at once" }, {}, { nothing: true }]) {
      const refusal = await refusalOf(app, statedRequest(payload));
      expect(refusal.status).toBe(400);
      expect(refusal.code).toBe("BAD_REQUEST");
    }
  });
});

test("an upload without a token is refused before it is read", async () => {
  await withHub(async ({ app }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/parse",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(fixtureBytes("sample.txt")),
    });
    expect(response.statusCode).toBe(401);
    expect(ErrorBodySchema.parse(response.json() as unknown).error.code).toBe("UNAUTHORIZED");
  });
});
