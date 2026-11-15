/**
 * Where a system path goes (F§10.4).
 *
 * A share intent has no deep link of its own, so `expo-sharing` rewrites the launch: it sets the intent's data to
 * `<scheme>://expo-sharing` and lets the navigation library treat it as an ordinary link. This file is the one
 * place that knows what that address means. Every path whose host is the share host becomes the handler screen;
 * every other path — `lectern://setup?…`, a plain route the app opened from inside itself — is passed through
 * unchanged, which is what expo-router's own `NativeIntent` contract asks for.
 *
 * The type is the installed `expo-router@58.0.31` typings' `NativeIntent["redirectSystemPath"]`, so the shape of
 * what the router calls this with, and what it may answer, is the package's own declaration rather than this
 * file's opinion.
 */

import type { NativeIntent } from "expo-router";

/** The host the share module gives the launch: the scheme's own name is the app's (`lectern`). */
const SHARE_HOST = "expo-sharing";

/** The route that reads a share. */
const HANDLE_SHARE = "/handle-share";

/** What every scheme-qualified address opens with. */
const SCHEME_SEPARATOR = "://";

/** Anything that ends the host part of an address. */
const HOST_END = /[/?#]/;

/**
 * The host of a system path — the part between the scheme's separator and the first `/`, `?` or `#` — or `null`
 * for a path that carries no scheme at all. Written with string arithmetic rather than `URL` because React
 * Native's URL is a partial polyfill and a redirect is the wrong place to depend on which parts it got.
 */
function hostOf(path: string): string | null {
  const marker = path.indexOf(SCHEME_SEPARATOR);
  if (marker < 0) return null;
  const afterScheme = path.slice(marker + SCHEME_SEPARATOR.length);
  const end = afterScheme.search(HOST_END);
  return (end < 0 ? afterScheme : afterScheme.slice(0, end)).toLowerCase();
}

export const redirectSystemPath: NonNullable<NativeIntent["redirectSystemPath"]> = ({ path }) =>
  hostOf(path) === SHARE_HOST ? HANDLE_SHARE : path;
