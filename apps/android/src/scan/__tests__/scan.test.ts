/**
 * The scanner's pure half (F§5.5, F§10.4).
 *
 * Only the two modules that need no device are tested here — the line mapping and the assembly — because this
 * package's Node test program parses `react-native` nowhere: `scan-service.ts` loads the scanner, the camera and
 * the recogniser through `import()` inside its own functions and is exercised on a device instead (U-052's
 * report). What a device is not needed to prove is proved here: that a recogniser's answer becomes F§5.5's
 * lines, that a page's lines become F§5.5's paragraphs, and that pages become F§5.1's document with its page
 * numbers and its title.
 *
 * The recognition fixture below is hand-written JSON, as the contract asks — it is not a recording of any
 * product, and the text is this file's own.
 */

import { groupOcrLines } from "@lectern/core";
import { describe, expect, it } from "vitest";
import { assembleScan, scanTitle } from "../assemble";
import { linesFromRecognition, pageHeightOf, type RecognizedPage, UNSCORED_CONFIDENCE } from "../mlkit-lines";

/** When the scans in these cases were assembled: 15 November 2026, 14:05, in the reader's own time. */
const ASSEMBLED_AT = new Date(2026, 10, 15, 14, 5);

/**
 * One page as the recogniser reports it: two lines of one paragraph whose whitespace gap is ordinary, then a
 * third line far enough down to be a paragraph of its own. The frames are the image's own pixels, which is the
 * only frame a recogniser can report in.
 */
const RECOGNISED_PAGE = {
  text: "The first page\nof a scan\nA second paragraph",
  blocks: [
    {
      text: "The first page\nof a scan",
      frame: { width: 600, height: 120, top: 40, left: 50 },
      lines: [
        { text: "The first page", frame: { width: 300, height: 40, top: 40, left: 50 } },
        { text: "of a scan", frame: { width: 220, height: 40, top: 84, left: 50 } },
      ],
    },
    {
      text: "A second paragraph",
      frame: { width: 400, height: 40, top: 260, left: 50 },
      lines: [{ text: "A second paragraph", frame: { width: 400, height: 40, top: 260, left: 50 } }],
    },
  ],
} satisfies RecognizedPage;

/** A page whose second line was read without a frame, and whose block has none either. */
const UNMEASURED_LINE_PAGE = {
  text: "Measured line\nUnmeasured line",
  blocks: [
    {
      text: "Measured line\nUnmeasured line",
      lines: [{ text: "Measured line", frame: { width: 200, height: 30, top: 100, left: 20 } }, { text: "Unmeasured line" }],
    },
  ],
} satisfies RecognizedPage;

describe("linesFromRecognition", () => {
  it("maps a recogniser's lines and frames to F§5.5's corner-pair boxes", () => {
    const lines = linesFromRecognition(RECOGNISED_PAGE, 300);
    expect(lines.map((line) => line.text)).toEqual(["The first page", "of a scan", "A second paragraph"]);
    expect(lines.map((line) => line.bbox)).toEqual([
      [50, 40, 350, 80],
      [50, 84, 270, 124],
      [50, 260, 450, 300],
    ]);
  });

  it("reports 100 for a line the recogniser did not score, and keeps a score it did", () => {
    const unscored = linesFromRecognition(RECOGNISED_PAGE, 300);
    expect(unscored.map((line) => line.confidence)).toEqual([UNSCORED_CONFIDENCE, UNSCORED_CONFIDENCE, UNSCORED_CONFIDENCE]);
    const scored = linesFromRecognition(
      { text: "Scored line", blocks: [{ text: "Scored line", lines: [{ text: "Scored line", confidence: 62 }] }] },
      300,
    );
    expect(scored.map((line) => line.confidence)).toEqual([62]);
  });

  it("places a line with no frame at the bottom of the line before it, and clamps it to the page", () => {
    const lines = linesFromRecognition(UNMEASURED_LINE_PAGE, 130);
    expect(lines.map((line) => line.bbox)).toEqual([
      [20, 100, 220, 130],
      [0, 130, 0, 130],
    ]);
    const clamped = linesFromRecognition(UNMEASURED_LINE_PAGE, 100);
    expect(clamped.map((line) => line.bbox)).toEqual([
      [20, 100, 220, 130],
      [0, 100, 0, 100],
    ]);
  });

  it("measures the page's height as the lowest edge any frame reaches", () => {
    expect(pageHeightOf(RECOGNISED_PAGE)).toBe(300);
    expect(pageHeightOf(UNMEASURED_LINE_PAGE)).toBe(130);
    expect(pageHeightOf({ text: "", blocks: [] })).toBe(0);
  });

  it("groups into the paragraphs F§5.5 describes, so the mapping and the grouping fit together", () => {
    const blocks = groupOcrLines(linesFromRecognition(RECOGNISED_PAGE, 300));
    expect(blocks.map((block) => block.text)).toEqual(["The first page of a scan", "A second paragraph"]);
    expect(blocks.every((block) => block.kind === "paragraph")).toBe(true);
  });
});

describe("assembleScan", () => {
  it("orders the pages as they were scanned and numbers them from one", () => {
    const document = assembleScan(
      [
        [
          { kind: "paragraph", text: "Page one opens." },
          { kind: "paragraph", text: "Page one closes." },
        ],
        [{ kind: "paragraph", text: "Page two opens." }],
        [{ kind: "paragraph", text: "Page three opens." }],
      ],
      ASSEMBLED_AT,
    );
    expect(document.blocks.map((block) => [block.page, block.text])).toEqual([
      [1, "Page one opens."],
      [1, "Page one closes."],
      [2, "Page two opens."],
      [3, "Page three opens."],
    ]);
    expect(document.blocks.map((block) => block.index)).toEqual([0, 1, 2, 3]);
  });

  it("is an on-device document: source.kind is ocr and no address is claimed", () => {
    const document = assembleScan([[{ kind: "paragraph", text: "Read from a photograph." }]], ASSEMBLED_AT);
    expect(document.source).toEqual({ kind: "ocr" });
    expect(document.schemaVersion).toBe(1);
    expect(document.wordCount).toBe(4);
  });

  it("names a scan after the minute it was assembled", () => {
    const document = assembleScan([[{ kind: "paragraph", text: "No heading opens this page." }]], ASSEMBLED_AT);
    expect(document.title).toBe("Scan 2026-11-15 14:05");
    expect(scanTitle(ASSEMBLED_AT)).toBe("Scan 2026-11-15 14:05");
  });

  it("lets a short opening heading name the document instead", () => {
    const document = assembleScan(
      [
        [
          { kind: "heading", level: 2, text: "Lecture Notes" },
          { kind: "paragraph", text: "The body follows." },
        ],
      ],
      ASSEMBLED_AT,
    );
    expect(document.title).toBe("Lecture Notes");
  });

  it("does not let a heading too long to be a name become the title", () => {
    const heading = `A heading that runs on past any reasonable name for a document ${"and on".repeat(6)}`;
    const document = assembleScan([[{ kind: "heading", level: 1, text: heading }]], ASSEMBLED_AT);
    expect(heading.length).toBeGreaterThan(60);
    expect(document.title).toBe("Scan 2026-11-15 14:05");
  });

  it("yields no document for a scan that read nothing at all", () => {
    const document = assembleScan([[], []], ASSEMBLED_AT);
    expect(document.blocks).toEqual([]);
    expect(document.title).toBe("");
    expect(document.sentenceCount).toBe(0);
    expect(document.wordCount).toBe(0);
  });

  it("assembles the recogniser's own paragraphs into the document that would be saved", () => {
    const document = assembleScan([groupOcrLines(linesFromRecognition(RECOGNISED_PAGE, 300))], ASSEMBLED_AT);
    expect(document.blocks.map((block) => block.text)).toEqual(["The first page of a scan", "A second paragraph"]);
    expect(document.blocks.map((block) => block.page)).toEqual([1, 1]);
    expect(document.title).toBe("Scan 2026-11-15 14:05");
    expect(document.sentenceCount).toBe(2);
  });
});
