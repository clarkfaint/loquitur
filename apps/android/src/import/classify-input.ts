/**
 * What a pasted string is (F§10.4's import).
 *
 * A reader's clipboard holds one of two things worth importing: an address the hub can fetch, or text. The two
 * go down different roads — an address becomes a hub request, text is built into a document on the device — so
 * the decision has to be made once, before either road is taken, and it is the whole of this module.
 *
 * The rule is deliberately narrow. A pasted string is an address only when the *whole* of it is one `http(s)`
 * URL: a URL inside a paragraph of prose is prose (it has whitespace in it), a bare host with no scheme is not
 * something F§7.2's `{ url }` form will fetch, and a string that parses as a URL of some other scheme
 * (`mailto:`, `file:`) is text, because the hub fetches `http` and `https` only. Everything that is not an
 * address is text — including an empty string, which is text with nothing in it, so a caller has one shape to
 * branch on rather than a third "nothing" case.
 */

/** A pasted string: an address for the hub to fetch (F§7.2), or text the reader pasted. */
export type PastedInput = { kind: "url"; url: string } | { kind: "text"; text: string };

/** The two schemes F§7.2's `{ url }` form fetches, and the only two an address may wear. */
const FETCHABLE_SCHEMES: readonly string[] = ["http:", "https:"];

/** Any whitespace at all, which no single address contains. */
const WHITESPACE = /\s/;

/**
 * The address a whole string is, or `null` when it is not exactly one: no whitespace, a URL the platform's own
 * parser accepts, a fetchable scheme, and a host that is not empty.
 */
function asFetchableUrl(value: string): string | null {
  if (value === "" || WHITESPACE.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!FETCHABLE_SCHEMES.includes(parsed.protocol)) return null;
  return parsed.host === "" ? null : value;
}

/**
 * `classifyPastedInput(value)` — the address a pasted string is, or the text it is. Surrounding whitespace is
 * dropped from either answer, so a URL copied with a trailing newline is still a URL.
 */
export function classifyPastedInput(value: string): PastedInput {
  const trimmed = value.trim();
  const url = asFetchableUrl(trimmed);
  return url === null ? { kind: "text", text: trimmed } : { kind: "url", url };
}
