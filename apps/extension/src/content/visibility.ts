/**
 * What a page's own rules allow the reader to read (F§10.2).
 *
 * A content script reads a page it does not own, so the first question it has to answer is which of the
 * page's elements may be read at all. F§10.2 fixes the list: code and markup (`script`, `style`,
 * `noscript`, `template`), the page's chrome (`nav`, `aside`, `footer`, and a `header` that carries
 * `role="banner"`), what the page itself declares hidden (`hidden`, `aria-hidden="true"`), the regions a
 * reader could type into (form controls and `contenteditable` elements), and elements with no box or no
 * visible style.
 *
 * The last clause is why the predicate takes an environment instead of a flag. `getBoundingClientRect`
 * and `getComputedStyle` answer only where a layout engine is present, and a caller without one — an
 * extension context, a test document — must not have a measurement invented for it. `hasLayout: false`
 * therefore means "the attribute-level rules apply and the measurement is skipped", which is a weaker
 * statement than "the element is visible".
 */

/** What the caller can measure about the document it is reading. */
export interface ReadableEnv {
  /**
   * Whether the document has a layout engine, so that zero-size and computed-style questions have
   * answers. `false` skips both, because neither can be answered from the tree alone.
   */
  hasLayout: boolean;
}

/** The tag of an element, lower case, whatever the document's own casing was. */
export function tagName(element: Element): string {
  return element.localName.toLowerCase();
}

/** Content that is code, styling or markup rather than prose, and never read as text. */
const UNREADABLE_TAGS: ReadonlySet<string> = new Set<string>(["script", "style", "noscript", "template"]);

/** The page's own chrome: its navigation, its sidebars and its footers. */
const CHROME_TAGS: ReadonlySet<string> = new Set<string>(["nav", "aside", "footer"]);

/** Regions a reader could type into, which are never read back. */
const FIELD_TAGS: ReadonlySet<string> = new Set<string>(["input", "select", "textarea"]);

/** The role that makes a `header` the page's banner rather than the article's own. */
const BANNER_ROLE = "banner";

/** The attribute value that hides an element's subtree from assistive technology. */
const HIDDEN_ARIA_VALUE = "true";

/** The value `contenteditable` needs to opt out of being editable. */
const EDITABLE_OFF_VALUE = "false";

/**
 * Whether an element's subtree may be read (F§10.2): its tag is not code, chrome or a field; it does not
 * carry the `hidden` attribute or `aria-hidden="true"`; it is not editable; and — only where the caller
 * says a layout engine is present — it has a box and a visible style.
 */
export function isReadableElement(element: Element, env: ReadableEnv): boolean {
  const tag = tagName(element);
  if (UNREADABLE_TAGS.has(tag)) return false;
  if (CHROME_TAGS.has(tag)) return false;
  if (FIELD_TAGS.has(tag)) return false;
  if (tag === "header" && attributeOf(element, "role") === BANNER_ROLE) return false;
  if (attributeOf(element, "aria-hidden") === HIDDEN_ARIA_VALUE) return false;
  if (element.hasAttribute("hidden")) return false;
  if (isEditable(element)) return false;
  return !(env.hasLayout && isInvisible(element));
}

/** An attribute's value, trimmed and lower-cased, or `""` when the element has none. */
function attributeOf(element: Element, name: string): string {
  return (element.getAttribute(name) ?? "").trim().toLowerCase();
}

/**
 * Whether an element's content is editable: `contenteditable` is present with any value but `"false"`.
 * The empty value (`contenteditable=""`) is the way HTML spells "editable", which is why presence is what
 * is tested rather than a truthy string.
 */
function isEditable(element: Element): boolean {
  const value = element.getAttribute("contenteditable");
  return value !== null && value.trim().toLowerCase() !== EDITABLE_OFF_VALUE;
}

/**
 * Whether an element is invisible to a reader with eyes: its computed style hides it, or it has no box at
 * all while holding text of its own. Both answers come from the layout engine, so this runs only when the
 * caller reported one.
 */
function isInvisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return false;
  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return true;
  const box = element.getBoundingClientRect();
  if (box.width !== 0 || box.height !== 0) return false;
  return (element.textContent ?? "").trim() !== "";
}
