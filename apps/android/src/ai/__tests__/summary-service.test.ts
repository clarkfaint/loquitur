/**
 * The Node-side tests of the Android summary service (AGENTS.md §7, F§9).
 *
 * `summaryDocument` is the unit's pure part — F§9's summary and its takeaways turned into an ordinary F§5.1
 * document — and it is the part a device is not needed to prove: the heading that names what was summarized,
 * the summary as its own paragraph, one list item per takeaway in the order the hub gave them, and F§5.2's
 * identity, which makes the same summary the same document every time it is built.
 *
 * The rest of the module reaches the hub, the app's stores and the platform's own fetch, so it is covered by
 * the on-device summary flow a later unit's manual report records, not here.
 */

import type { AnySummaryResult } from "@lectern/api-contract";
import { describe, expect, it } from "vitest";
import { summaryDocument } from "../summary-service";

/** F§9's own result shape: the summary, its takeaways, the model, the prompt version and when it was made. */
const RESULT: AnySummaryResult = {
  summary: "The chapter sets out the three ways a promise can be enforced and when each one is available.",
  keyTakeaways: [
    "A promise is enforced by damages, by specific performance, or by a declaration.",
    "Damages are the default remedy and need no showing of hardship.",
    "Specific performance is refused where damages would be adequate.",
    "A declaration settles the parties' rights without ordering anyone to act.",
    "The remedy follows the interest the promise created, not the words used.",
  ],
  model: "mock-llm-1",
  promptVersion: "1",
  createdAt: 1_700_000_000_000,
};

describe("summaryDocument", () => {
  it("opens with a heading naming the document it summarizes", () => {
    const model = summaryDocument(RESULT, "Chapter 3 — Remedies");
    const heading = model.blocks[0];
    expect(heading?.kind).toBe("heading");
    expect(heading?.text).toBe("Summary of Chapter 3 — Remedies");
    expect(model.title).toBe("Summary of Chapter 3 — Remedies");
  });

  it("falls back to a plain heading when the document has no title", () => {
    expect(summaryDocument(RESULT, "   ").blocks[0]?.text).toBe("Summary");
  });

  it("carries the summary as its own paragraph", () => {
    const paragraphs = summaryDocument(RESULT, "Chapter 3 — Remedies").blocks.filter((block) => block.kind === "paragraph");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toBe(RESULT.summary);
  });

  it("makes one list item per takeaway, in order", () => {
    const items = summaryDocument(RESULT, "Chapter 3 — Remedies").blocks.filter((block) => block.kind === "list-item");
    expect(items.map((item) => item.text)).toEqual(RESULT.keyTakeaways);
  });

  it("is F§9's own source kind, so the library can tell a summary from a parse", () => {
    expect(summaryDocument(RESULT, "Chapter 3 — Remedies").source.kind).toBe("summary");
  });

  it("is a valid document: the counts and the block indexes describe what was built", () => {
    const model = summaryDocument(RESULT, "Chapter 3 — Remedies");
    expect(model.schemaVersion).toBe(1);
    expect(model.blocks.map((block) => block.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(model.sentenceCount).toBe(model.blocks.reduce((total, block) => total + block.sentences.length, 0));
    expect(model.wordCount).toBeGreaterThan(0);
  });

  it("has a stable docId for the same summary, and a different one for a different summary", () => {
    const first = summaryDocument(RESULT, "Chapter 3 — Remedies");
    const second = summaryDocument(RESULT, "Chapter 3 — Remedies");
    expect(second.docId).toBe(first.docId);
    // F§5.2's identity is the block texts, so the heading's own title is part of it — and a changed takeaway is
    // a different document, which is what keeps two summaries apart in the library.
    const other = summaryDocument({ ...RESULT, keyTakeaways: [...RESULT.keyTakeaways, "A sixth takeaway."] }, "Chapter 3 — Remedies");
    expect(other.docId).not.toBe(first.docId);
  });
});
