import { expect, test } from "vitest";
import { parseMarkdown, parseText } from "../text";

test("parseText makes one paragraph per run of non-blank lines", () => {
  const blocks = parseText("First paragraph.\nStill the first.\n\nSecond paragraph.");
  expect(blocks).toEqual([
    { kind: "paragraph", text: "First paragraph.\nStill the first." },
    { kind: "paragraph", text: "Second paragraph." },
  ]);
  expect(parseText("   \n\n\t\n")).toEqual([]);
});

test("parseText strips inline Markdown markers", () => {
  const blocks = parseText("**bold** and *italic* and `code` and [link](https://example.com) and ![img](x.png)");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.text).toBe("bold and italic and code and link and img");
});

test("inline code spans keep their underscores instead of losing them to emphasis", () => {
  expect(parseText("Use `snake_case_name` in prose")[0]?.text).toBe("Use snake_case_name in prose");
  expect(parseText("Plain snake_case_name stays")[0]?.text).toBe("Plain snake_case_name stays");
  expect(parseMarkdown("_italic_ here")[0]?.text).toBe("italic here");
});

test("parseMarkdown turns hash runs into headings of the right level", () => {
  const blocks = parseMarkdown("# One\n\n### Three\n\n###### Six");
  expect(blocks).toEqual([
    { kind: "heading", level: 1, text: "One" },
    { kind: "heading", level: 3, text: "Three" },
    { kind: "heading", level: 6, text: "Six" },
  ]);
});

test("seven hashes and a hash with no space are ordinary paragraphs", () => {
  const blocks = parseMarkdown("####### seven\n\n#NoSpace");
  expect(blocks).toEqual([
    { kind: "paragraph", text: "####### seven" },
    { kind: "paragraph", text: "#NoSpace" },
  ]);
});

test("parseMarkdown makes one list item per marker line", () => {
  const blocks = parseMarkdown("- alpha\n* beta\n1. gamma\n2) delta");
  expect(blocks).toEqual([
    { kind: "list-item", text: "alpha" },
    { kind: "list-item", text: "beta" },
    { kind: "list-item", text: "gamma" },
    { kind: "list-item", text: "delta" },
  ]);
});

test("consecutive quote lines become one quote block", () => {
  const blocks = parseMarkdown("> first line\n> second line\n\nAfter the quote.");
  expect(blocks).toEqual([
    { kind: "quote", text: "first line\nsecond line" },
    { kind: "paragraph", text: "After the quote." },
  ]);
});

test("blocks keep document order when paragraph, heading, list and quote meet", () => {
  const blocks = parseMarkdown("Intro paragraph.\n\n## Heading\n\n- item one\n\n> a quote\n\nTail.");
  expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "heading", "list-item", "quote", "paragraph"]);
  expect(blocks.map((block) => block.text)).toEqual(["Intro paragraph.", "Heading", "item one", "a quote", "Tail."]);
});

test("parseMarkdown handles CRLF input and empty input", () => {
  expect(parseMarkdown("# One\r\n\r\nBody.")).toEqual([
    { kind: "heading", level: 1, text: "One" },
    { kind: "paragraph", text: "Body." },
  ]);
  expect(parseMarkdown("")).toEqual([]);
});
