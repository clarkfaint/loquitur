import { expect, test } from "vitest";
import { normalizeText } from "../normalize";

test("step 1 — text is normalized to Unicode NFC", () => {
  const decomposed = "e\u0301";
  expect(decomposed).not.toBe("\u00e9");
  expect(normalizeText(decomposed)).toBe("\u00e9");
  expect(normalizeText("A\u030A")).toBe("\u00c5");
});

test("step 2 — CRLF and CR become LF", () => {
  expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
  expect(normalizeText("a\r\n\r\nb")).toBe("a\n\nb");
});

test("step 3 — U+00A0 becomes a space", () => {
  expect(normalizeText("a\u00a0b")).toBe("a b");
  expect(normalizeText("\u00a0")).toBe("");
});

test("step 4 — U+00AD is removed", () => {
  expect(normalizeText("co\u00adoperate")).toBe("cooperate");
  expect(normalizeText("a\u00adb")).toBe("ab");
});

test("step 5 — runs of spaces and tabs collapse to one space", () => {
  expect(normalizeText("a   b\t\tc")).toBe("a b c");
  expect(normalizeText("a \t \t b")).toBe("a b");
});

test("step 6 — every line is trimmed", () => {
  expect(normalizeText("  a  \n\tb\t")).toBe("a\nb");
});

test("step 7 — three or more newlines collapse to two", () => {
  expect(normalizeText("a\n\n\n\n\nb")).toBe("a\n\nb");
  expect(normalizeText("a\n\nb")).toBe("a\n\nb");
});

test("step 8 — the whole string is trimmed", () => {
  expect(normalizeText("\n\n  a  \n\n")).toBe("a");
  expect(normalizeText("")).toBe("");
});

test("normalization is idempotent", () => {
  const inputs = [
    "",
    "Hello, world.",
    "\u00a0",
    "  e\u0301\r\n\r\n\r\n  a\u00a0\u00adb  \t",
    "a\n\n\n\nb",
    "one\ttwo  three",
    "\u00e9\u6f22\ud83d\ude42",
  ];
  for (const input of inputs) {
    const once = normalizeText(input);
    expect(normalizeText(once)).toBe(once);
  }
});
