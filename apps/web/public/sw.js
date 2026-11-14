/**
 * Lectern's app shell, kept by the browser (F§10.1).
 *
 * The page is a hash-routed single-page app whose assets are addressed relatively, so precaching the files
 * `vite build` emitted is enough to start it with no network at all: `index.html` and the bundles beside it
 * are everything a reload asks for before the reader is reading from their own library.
 *
 * Three rules decide what this worker touches. It answers only a same-origin `GET`, so hub traffic — another
 * origin whenever the hub is another host, `/v1/` everywhere — goes to the network untouched and a cached
 * answer can never stand in for a hub's. It serves a precached file cache-first, because a built asset's name
 * carries its own content. And it serves the shell itself network-first with a cache fallback, because
 * `index.html` names the asset files: a stale copy of it would point at bundles a later build no longer
 * serves.
 *
 * Plain JavaScript on purpose: a service worker is fetched on its own, outside every bundle, and
 * `apps/web/public/` is copied into `dist/` exactly as it stands. The build writes the file list this worker
 * precaches, `precache-manifest.json`, beside it.
 */

/** The generation of cache this worker fills. Bumping the version is what retires the previous one. */
const CACHE_NAME = "lectern-precache-v1";

/** Every cache this worker has owned shares this prefix, which is how `activate` recognises the old ones. */
const CACHE_PREFIX = "lectern-precache-";

/** The build's file list, and the shell it names, both resolved against this worker's own location. */
const MANIFEST_URL = new URL("./precache-manifest.json", self.location.href).href;
const SHELL_URL = new URL("./index.html", self.location.href).href;

/** Whether a request is for a page of this app rather than for one of the files beside it. */
function isShellRequest(request, url) {
  if (request.mode === "navigate") return true;
  return url.pathname === "/" || url.pathname.endsWith("/index.html");
}

/**
 * The file list the build wrote: every path it emitted, relative to the app's root. A manifest that cannot be
 * read, or that holds no list, is a failure the install must hear about rather than an empty precache.
 */
async function manifestFiles() {
  const answer = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!answer.ok) throw new Error(`precache-manifest.json answered ${answer.status}`);
  const manifest = await answer.json();
  const files = manifest === null || typeof manifest !== "object" ? undefined : manifest.files;
  if (!Array.isArray(files)) throw new Error("precache-manifest.json holds no file list");
  return files.filter((file) => typeof file === "string");
}

/** Cache every file the build emitted. A failure leaves no half-filled cache behind to be served from. */
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  try {
    const files = await manifestFiles();
    await cache.addAll(files.map((file) => new URL(file, self.location.href).href));
  } catch (cause) {
    await caches.delete(CACHE_NAME);
    throw cause;
  }
}

/** Delete every cache an earlier generation of this worker filled. */
async function retireOldCaches() {
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
  }
}

/**
 * A precached answer for a request, or `undefined`.
 *
 * `ignoreVary` is not decoration. A built asset is requested in CORS mode — `vite build` marks its own script
 * and stylesheet `crossorigin` — so the request carries an `Origin` header, while the install's own request for
 * the same file had none; the server sends `Vary: Origin`, and a `Vary` mismatch is a miss even though the
 * bytes are right there. Measured: with `Vary: Origin` and `Origin` on the request, `cache.match(request)`
 * answered nothing and `cache.match(request, { ignoreVary: true })` answered the file. This app serves one
 * variant per URL, so the header distinguishes nothing worth distinguishing.
 */
async function precached(request) {
  const cache = await caches.open(CACHE_NAME);
  return await cache.match(request, { ignoreVary: true });
}

/**
 * The shell: the network's own answer whenever there is one, refreshed into the cache so the next offline
 * load is the newest build, and the precached file when the network is not there.
 */
async function shellFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const answer = await fetch(request);
    if (answer.ok) await cache.put(SHELL_URL, answer.clone());
    return answer;
  } catch (cause) {
    const cached = (await precached(request)) ?? (await precached(SHELL_URL));
    if (cached !== undefined) return cached;
    throw cause;
  }
}

/** A built file: what was precached, and the network only for something this build did not emit. */
async function cachedFirst(request) {
  const cached = await precached(request);
  if (cached !== undefined) return cached;
  return await fetch(request);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(retireOldCaches());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // F§7.2's routes belong to the hub: a cached hub answer would be an answer about another build's data.
  if (url.pathname.startsWith("/v1/")) return;
  event.respondWith(isShellRequest(request, url) ? shellFirst(request) : cachedFirst(request));
});
