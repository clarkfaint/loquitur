/**
 * The paste classifier's tests (AGENTS.md §7).
 *
 * `classify-input.ts` is the whole of the decision between the two import roads — an address for the hub to
 * fetch, or text built into a document on the device — so it is the one module of this unit that can be proved
 * under Node: the screens and the import service stand on React Native, `expo-clipboard` and the store, and are
 * covered by the on-device diagnostics screen a later unit verifies through `adb`, not by this package's Node
 * test program.
 *
 * The five cases the contract names are here, plus the three edges the same rule implies: a URL of a scheme the
 * hub will not fetch, a bare host with no scheme, and a whitespace-only string. The strings are original Lectern
 * test text and reserve example addresses.
 */

import { describe, expect, it } from "vitest";
import { classifyPastedInput } from "../classify-input";

describe("classifyPastedInput", () => {
  it("reads a lone address as a URL", () => {
    expect(classifyPastedInput("https://reader.example.org/notes/lecture-3")).toEqual({
      kind: "url",
      url: "https://reader.example.org/notes/lecture-3",
    });
  });

  it("reads an address with whitespace around it as that URL", () => {
    expect(classifyPastedInput("  http://hub.example.org:8787/page?ref=2\n")).toEqual({
      kind: "url",
      url: "http://hub.example.org:8787/page?ref=2",
    });
  });

  it("reads an address inside prose as text", () => {
    const prose = "See https://reader.example.org/notes for the reading list.";
    expect(classifyPastedInput(prose)).toEqual({ kind: "text", text: prose });
  });

  it("reads plain text as text", () => {
    expect(classifyPastedInput("The ferry leaves at dawn.")).toEqual({
      kind: "text",
      text: "The ferry leaves at dawn.",
    });
  });

  it("reads an empty string as empty text", () => {
    expect(classifyPastedInput("")).toEqual({ kind: "text", text: "" });
  });

  it("reads a whitespace-only string as empty text", () => {
    expect(classifyPastedInput(" \n\t ")).toEqual({ kind: "text", text: "" });
  });

  it("reads a scheme the hub will not fetch as text", () => {
    expect(classifyPastedInput("mailto:reader@example.org")).toEqual({ kind: "text", text: "mailto:reader@example.org" });
  });

  it("reads a bare host with no scheme as text", () => {
    expect(classifyPastedInput("reader.example.org/notes")).toEqual({ kind: "text", text: "reader.example.org/notes" });
  });
});
