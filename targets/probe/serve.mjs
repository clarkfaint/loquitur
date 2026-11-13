#!/usr/bin/env node
// Lectern probe server: a zero-dependency static file server for targets/probe/.
//
//   node targets/probe/serve.mjs [--port <n>]
//
// Serves this directory on 127.0.0.1:4173 by default. Later units load
// http://127.0.0.1:4173/article.html here as the local probe page.

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_FILE = "article.html";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return DEFAULT_PORT;
  const raw = argv[index + 1] ?? "";
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`invalid --port value: ${raw}`);
  }
  return value;
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end(body);
}

function plain(response, status, message) {
  respond(response, status, `${message}\n`, { "content-type": "text/plain; charset=utf-8" });
}

// Resolve a request pathname to a file inside ROOT, or null when it escapes ROOT.
function resolveInside(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.endsWith("/") ? `${decoded}${DEFAULT_FILE}` : decoded === "" ? `/${DEFAULT_FILE}` : decoded;
  const target = resolve(ROOT, `.${relative}`);
  if (target !== ROOT && !target.startsWith(`${ROOT}${sep}`)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    plain(response, 405, "method not allowed");
    return;
  }
  let target;
  try {
    target = resolveInside(new URL(request.url ?? "/", `http://${HOST}`).pathname);
  } catch {
    plain(response, 400, "bad request");
    return;
  }
  if (target === null) {
    plain(response, 403, "forbidden");
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      plain(response, 404, "not found");
      return;
    }
    const body = await readFile(target);
    respond(response, 200, request.method === "HEAD" ? "" : body, {
      "content-type": CONTENT_TYPES.get(extname(target).toLowerCase()) ?? "application/octet-stream",
      "content-length": String(body.byteLength),
    });
  } catch {
    plain(response, 404, "not found");
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}

const port = parsePort(process.argv.slice(2));
server.listen(port, HOST, () => {
  console.log(`Lectern probe server listening on http://${HOST}:${port}`);
  console.log(`Probe article: http://${HOST}:${port}/${DEFAULT_FILE}`);
  console.log(`Probe text:    http://${HOST}:${port}/probe.txt`);
  console.log("Press Ctrl+C to stop.");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
