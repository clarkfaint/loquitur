/**
 * The PDF hand-off's tests (F§10.2).
 *
 * Three groups, and each is a question the contract asks. The *detector* is judged on the shapes a URL can
 * take — an extension, its case, a query string, a fragment, a path with `.pdf` in the middle — because a
 * false positive hands an ordinary page to the web app and a false negative leaves a PDF unreadable. The
 * *address* is judged on what it encodes: the PDF's own URL, whole, as one query parameter of F§10.1's import
 * route. The *refusals* are judged one by one through the handler itself, with an injected platform, so the
 * answer a reader sees for each is pinned rather than reasoned about — and the order the three are decided in
 * is pinned too, because a local `…/paper.pdf` is a local file before it is a PDF.
 *
 * The last case is the registration: the handler answers `ext/open-pdf` through the service worker's own
 * router, and only after it has been installed — which is what keeps U-032's frozen registry test true of the
 * module as declared.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  type HandoffTab,
  handoffActiveTab,
  handoffUrl,
  installPdfHandoff,
  isPdfUrl,
  LOCAL_FILE,
  NO_WEB_APP,
  NOT_A_PDF,
  type PdfHandoffPlatform,
} from "../pdf-handoff";
import { NO_ACTIVE_TAB } from "../read-active-tab";
import { handleMessage } from "../router";

/** The web app address every case but the `NO_WEB_APP` one is configured with. */
const WEB_APP = "https://lectern.example";

/** The sender a synthetic message arrives with: an extension page, not a tab. */
const SENDER = {} as chrome.runtime.MessageSender;

/** A platform that answers with one tab, one web app address and one record of what was opened. */
function platformFor(tab: HandoffTab | null, webAppUrl: string = WEB_APP): PdfHandoffPlatform & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    activeTab: async () => tab,
    openTab: async (url) => {
      opened.push(url);
    },
    webAppUrl: async () => webAppUrl,
  };
}

/** An ordinary `https` page. */
const PAGE: HandoffTab = { url: "https://harbour.example/notes.html", incognito: false };

/** A PDF over `https`, which is the one address a hand-off is for. */
const PDF: HandoffTab = { url: "https://harbour.example/tide-tables.pdf", incognito: false };

describe("isPdfUrl", () => {
  it("accepts a path that ends in the extension, whatever the rest of the address holds", () => {
    expect(isPdfUrl("https://harbour.example/tide-tables.pdf")).toBe(true);
    expect(isPdfUrl("https://harbour.example/deep/path/notes.PDF")).toBe(true);
    expect(isPdfUrl("https://harbour.example/tide-tables.pdf?page=3")).toBe(true);
    expect(isPdfUrl("https://harbour.example/tide-tables.pdf#page=3")).toBe(true);
    expect(isPdfUrl("http://127.0.0.1:4173/paper.pdf")).toBe(true);
    // The extension is judged on the path, so a `file:` address is a PDF *name*; the handler refuses the
    // scheme before this is ever reached, and the two questions are kept apart on purpose.
    expect(isPdfUrl("file:///home/reader/paper.pdf")).toBe(true);
  });

  it("refuses everything that is not a path ending in the extension", () => {
    expect(isPdfUrl("https://harbour.example/notes.html")).toBe(false);
    expect(isPdfUrl("https://harbour.example/read?document=tide.pdf")).toBe(false);
    expect(isPdfUrl("https://harbour.example/tide.pdf.html")).toBe(false);
    expect(isPdfUrl("https://harbour.example/tide.pdf/notes")).toBe(false);
    expect(isPdfUrl("https://harbour.example/tide.pdfx")).toBe(false);
    expect(isPdfUrl("pdf")).toBe(false);
    expect(isPdfUrl("")).toBe(false);
  });
});

describe("handoffUrl", () => {
  it("opens the web app's import route with the PDF's address encoded as its one parameter", () => {
    expect(handoffUrl(WEB_APP, PDF.url)).toBe(`${WEB_APP}/#/import?url=${encodeURIComponent(PDF.url)}`);
  });

  it("does not double a trailing slash, and keeps the rest of the web app's own address", () => {
    expect(handoffUrl(`${WEB_APP}/`, PDF.url)).toBe(`${WEB_APP}/#/import?url=${encodeURIComponent(PDF.url)}`);
    expect(handoffUrl("https://reader.example/lectern", PDF.url)).toBe(
      `https://reader.example/lectern/#/import?url=${encodeURIComponent(PDF.url)}`,
    );
  });

  it("carries a query string, a space and a fragment through intact", () => {
    const awkward = "https://harbour.example/a paper.pdf?ref=notes#page=2";
    expect(handoffUrl(WEB_APP, awkward)).toContain(encodeURIComponent(awkward));
    expect(handoffUrl(WEB_APP, awkward)).toContain("%20");
    expect(handoffUrl(WEB_APP, awkward)).toContain("%3F");
    expect(handoffUrl(WEB_APP, awkward)).toContain("%23");
  });
});

describe("the handler's refusals", () => {
  it("refuses an ordinary page with NOT_A_PDF", async () => {
    const platform = platformFor(PAGE);
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: false, code: NOT_A_PDF });
    expect(platform.opened).toEqual([]);
  });

  it("refuses a file on this computer with LOCAL_FILE, even when it is a PDF", async () => {
    const platform = platformFor({ url: "file:///home/reader/paper.pdf", incognito: false });
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: false, code: LOCAL_FILE });
    expect(platform.opened).toEqual([]);
  });

  it("refuses a private window's PDF with LOCAL_FILE", async () => {
    const platform = platformFor({ ...PDF, incognito: true });
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: false, code: LOCAL_FILE });
    expect(platform.opened).toEqual([]);
  });

  it("refuses a PDF with nothing to open it in with NO_WEB_APP", async () => {
    const platform = platformFor(PDF, "");
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: false, code: NO_WEB_APP });
    expect(platform.opened).toEqual([]);
  });

  it("refuses when there is no tab at all with NO_ACTIVE_TAB", async () => {
    const platform = platformFor(null);
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: false, code: NO_ACTIVE_TAB });
    expect(platform.opened).toEqual([]);
  });

  it("decides the address's own eligibility before it decides whether it is a PDF", async () => {
    // The refusal a reader sees must be the first rule that applies, not whichever check happens to be last.
    const platform = platformFor({ url: "chrome://settings/paper.pdf", incognito: false });
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: false, code: LOCAL_FILE });
  });
});

describe("the handler's hand-off", () => {
  it("opens the hand-off URL in a new tab and answers with it", async () => {
    const platform = platformFor(PDF);
    const expected = `${WEB_APP}/#/import?url=${encodeURIComponent(PDF.url)}`;
    await expect(handoffActiveTab(platform)).resolves.toMatchObject({ ok: true, data: { url: expected } });
    expect(platform.opened).toEqual([expected]);
  });
});

describe("installPdfHandoff", () => {
  it("answers ext/open-pdf through the service worker's router only once it is installed", async () => {
    const before = await handleMessage({ type: "ext/open-pdf" }, SENDER);
    expect(before).toMatchObject({ ok: false, code: "NO_HANDLER" });

    installPdfHandoff(platformFor(PAGE));
    const after = await handleMessage({ type: "ext/open-pdf" }, SENDER);
    expect(after).toMatchObject({ ok: false, code: NOT_A_PDF });
  });

  it("leaves every other message type to the handler that owns it", async () => {
    installPdfHandoff(platformFor(PAGE));
    await expect(handleMessage({ type: "ext/stop" }, SENDER)).resolves.toMatchObject({ ok: false, code: "NO_HANDLER" });
  });
});

beforeEach(() => {
  globalThis.chrome = {
    tabs: { query: async () => [], create: async () => ({}) },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  } as unknown as typeof chrome;
});
