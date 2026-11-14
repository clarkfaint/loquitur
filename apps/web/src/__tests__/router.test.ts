/**
 * The router's tests (F§10.1): pattern matching, parameters, query strings, and the locations that match
 * nothing.
 *
 * `useHashRoute` is exercised against a real React root rather than a stand-in, because the hook's whole job is
 * to move with the address bar. `happy-dom` does not raise `hashchange` when `location.hash` is assigned, so
 * the test dispatches the event a browser would — which is also what proves the hook listens for the event
 * rather than reading the hash once and forgetting it.
 */

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { currentHash, matchRoute, navigate, parseHash, useHashRoute } from "../router";

declare global {
  /** React 19 asks for this flag before `act` drives a render; the DOM library has no name for it. */
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

afterEach(() => {
  window.location.hash = "";
});

/** The page the hook test renders: it prints the path and the hash `useHashRoute` handed it. */
function Probe(): ReactElement {
  const route = useHashRoute();
  return createElement("p", { "data-path": route.path }, route.hash);
}

describe("parseHash", () => {
  it("splits a hash into its path and its query", () => {
    const route = parseHash("#/read/abc123?autoplay=1&word=4");
    expect(route.hash).toBe("#/read/abc123?autoplay=1&word=4");
    expect(route.path).toBe("/read/abc123");
    expect(route.query.get("autoplay")).toBe("1");
    expect(route.query.get("word")).toBe("4");
  });

  it("reads a hash written without its marker", () => {
    expect(parseHash("/library").hash).toBe("#/library");
    expect(parseHash("/library").path).toBe("/library");
  });

  it("reads an empty hash as the root", () => {
    expect(parseHash("").path).toBe("/");
    expect(parseHash("").query.size).toBe(0);
  });

  it("drops trailing slashes and adds a missing leading one", () => {
    expect(parseHash("#/settings/").path).toBe("/settings");
    expect(parseHash("#settings").path).toBe("/settings");
  });

  it("parses a query-only hash, which the import route uses", () => {
    const route = parseHash("#?url=http%3A%2F%2Fexample.test%2Fpage");
    expect(route.path).toBe("/");
    expect(route.query.get("url")).toBe("http://example.test/page");
  });
});

describe("matchRoute", () => {
  it("matches a literal pattern and captures nothing", () => {
    const match = matchRoute("/settings", "#/settings");
    expect(match).not.toBeNull();
    expect(match?.pattern).toBe("/settings");
    expect(match?.path).toBe("/settings");
    expect(match?.params).toEqual({});
    expect(match?.query.size).toBe(0);
  });

  it("captures a parameter segment", () => {
    expect(matchRoute("/read/:docId", "#/read/abc123")?.params).toEqual({ docId: "abc123" });
  });

  it("reads the query beside a parameter", () => {
    const match = matchRoute("/read/:docId", "#/read/abc123?autoplay=1");
    expect(match?.params.docId).toBe("abc123");
    expect(match?.query.get("autoplay")).toBe("1");
  });

  it("decodes a captured segment, and keeps a malformed escape as written", () => {
    expect(matchRoute("/read/:docId", "#/read/a%20b")?.params.docId).toBe("a b");
    expect(matchRoute("/read/:docId", "#/read/%zz")?.params.docId).toBe("%zz");
  });

  it("accepts a location written without its marker and one with a trailing slash", () => {
    expect(matchRoute("/read/:docId", "/read/abc")?.params.docId).toBe("abc");
    expect(matchRoute("/settings/", "#/settings")?.path).toBe("/settings");
  });

  it("matches the root pattern", () => {
    const match = matchRoute("/", "#");
    expect(match?.params).toEqual({});
    expect(match?.path).toBe("/");
  });

  it("matches nothing for an unknown route", () => {
    expect(matchRoute("/library", "#/settings")).toBeNull();
  });

  it("matches nothing when the two paths hold a different number of segments", () => {
    expect(matchRoute("/settings", "#/settings/playback")).toBeNull();
    expect(matchRoute("/read/:docId", "#/read")).toBeNull();
  });

  it("matches nothing for an empty parameter or a malformed one", () => {
    expect(matchRoute("/read/:docId", "#/read/")).toBeNull();
    expect(matchRoute("/read/:", "#/read/abc")).toBeNull();
  });
});

describe("navigate", () => {
  it("writes the hash the router reads", () => {
    navigate("/settings");
    expect(currentHash()).toBe("#/settings");
    expect(parseHash(currentHash()).path).toBe("/settings");
  });

  it("writes a hash given with its marker, and keeps the query", () => {
    navigate("#/read/abc123?autoplay=1");
    expect(currentHash()).toBe("#/read/abc123?autoplay=1");
    expect(matchRoute("/read/:docId", currentHash())?.query.get("autoplay")).toBe("1");
  });
});

describe("useHashRoute", () => {
  it("hands its caller the current location and moves with it", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe));
    });
    expect(container.querySelector("p")?.getAttribute("data-path")).toBe("/");

    navigate("/settings?tab=voice");
    window.dispatchEvent(new Event("hashchange"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("p")?.getAttribute("data-path")).toBe("/settings");
    expect(container.querySelector("p")?.textContent).toBe("#/settings?tab=voice");

    navigate("/library");
    window.dispatchEvent(new Event("hashchange"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("p")?.getAttribute("data-path")).toBe("/library");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
