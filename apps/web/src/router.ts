/**
 * The app's hash router (F§10.1). A route is a pattern (`/read/:docId`) and a location is the part of the
 * address bar after `#`, so a link is an ordinary `<a href="#/read/abc123">`: the browser owns navigation,
 * the back button works, and the desktop shell (F§10.3) can load the same build from disk without a server
 * rewriting paths.
 *
 * The module is deliberately small and dependency-free beyond React's two hooks. Matching is a pure
 * function of a pattern and a hash, which is what makes it testable without a browser; `useHashRoute`
 * is the only part that reads the address bar, and it hands a page the values it needs so a route's
 * component never takes props (F§10.1's `routes` registry stores `ComponentType`).
 */

import { useEffect, useState } from "react";

/** The values a pattern's `:name` segments captured from a location. */
export type RouteParams = Record<string, string>;

/** One location, matched against a pattern with `matchRoute`. */
export interface RouteMatch {
  /** The pattern that matched, exactly as the caller wrote it. */
  pattern: string;
  /** The matched path, without a leading `#` and without its query — for example `/read/abc123`. */
  path: string;
  /** The values the pattern's `:name` segments captured. */
  params: RouteParams;
  /** The location's query, parsed. Empty when the location has none. */
  query: URLSearchParams;
}

/** A location as the address bar holds it: the hash itself, its path, and its query. */
export interface HashRoute {
  /** The whole hash, with the leading `#` — for example `#/read/abc123?autoplay=1`. */
  hash: string;
  /** Its path — for example `/read/abc123`. The root path is `/`. */
  path: string;
  /** Its query, parsed. */
  query: URLSearchParams;
}

/** The marker a pattern's parameter segment starts with. */
const PARAM_PREFIX = ":";

/** A parameter segment's whole shape: a colon and a JavaScript-style name. */
const PARAM_SEGMENT = /^:[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * A path with a leading `#` removed, its trailing slashes dropped and a leading slash ensured, so
 * `/settings/`, `settings` and `#/settings` are one location. The root path stays `/` rather than becoming
 * the empty string, which keeps the two forms of "the app's home" from being different routes.
 */
function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** A normalized path's segments. The root path has none. */
function segmentsOf(path: string): string[] {
  const trimmed = path.replace(/^\/+/u, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

/**
 * A captured segment as text. A malformed escape (`%zz`) is left as it was written instead of throwing, so
 * a hand-typed address cannot make routing fail.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * `parseHash(hash)` — a location's path and query, tolerating a hash with or without its `#` and one that is
 * only a query (`#?url=…`, which F§10.1's import route accepts).
 */
export function parseHash(hash: string): HashRoute {
  const marked = hash.startsWith("#") ? hash : `#${hash}`;
  const body = marked.slice(1);
  const queryAt = body.indexOf("?");
  const path = queryAt === -1 ? body : body.slice(0, queryAt);
  const query = queryAt === -1 ? "" : body.slice(queryAt + 1);
  return { hash: marked, path: normalizePath(path), query: new URLSearchParams(query) };
}

/**
 * `matchRoute(pattern, hash)` — the location's values under a pattern, or `null` when it does not match.
 *
 * A `:name` segment captures exactly one non-empty segment; every other segment must be equal. The two paths
 * must hold the same number of segments, so `/settings` does not match `#/settings/voice`, and a pattern
 * whose parameter segment is malformed (`/read/:`) matches nothing rather than everything.
 */
export function matchRoute(pattern: string, hash: string): RouteMatch | null {
  const location = parseHash(hash);
  const patternSegments = segmentsOf(normalizePath(pattern));
  const pathSegments = segmentsOf(location.path);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: RouteParams = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index] ?? "";
    const pathSegment = pathSegments[index] ?? "";
    if (patternSegment.startsWith(PARAM_PREFIX)) {
      if (!PARAM_SEGMENT.test(patternSegment) || pathSegment === "") return null;
      params[patternSegment.slice(PARAM_PREFIX.length)] = decodeSegment(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) return null;
  }
  return { pattern, path: location.path, params, query: location.query };
}

/** The address bar's hash right now, exactly as it is written there (empty when there is none). */
export function currentHash(): string {
  return window.location.hash;
}

/**
 * `navigate(hash)` — move the app to a location.
 *
 * A target the address bar already holds is not written again: the shell redirects to settings on some
 * renders, and pushing one history entry per render would fill the back button with the same screen.
 */
export function navigate(hash: string): void {
  const target = parseHash(hash).hash;
  if (currentHash() === target) return;
  window.location.hash = target;
}

/**
 * `useHashRoute()` — the current location, re-rendering its caller whenever the address bar changes.
 *
 * A page reads its own parameters from this (`matchRoute("/read/:docId", useHashRoute().hash)`), which is why
 * a registered route's component takes no props. The address bar is read once more inside the effect because
 * it can have moved between the first render and the effect — a redirect, or the back button.
 */
export function useHashRoute(): HashRoute {
  const [hash, setHash] = useState(currentHash);

  useEffect(() => {
    const read = (): void => setHash(currentHash());
    window.addEventListener("hashchange", read);
    read();
    return () => window.removeEventListener("hashchange", read);
  }, []);

  return parseHash(hash);
}
