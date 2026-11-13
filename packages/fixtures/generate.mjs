#!/usr/bin/env node
/**
 * Lectern fixture generator (U-005).
 *
 * One input, `source/lighthouse.md`, and nine derived artefacts. Every file under `generated/` is
 * written by this script from that single parse, so the fixtures cannot drift apart; the generated
 * files are committed and are never built at test time.
 *
 *   node generate.mjs                 write every fixture into ./generated
 *   node generate.mjs --check         build into a temporary directory, validate it, exit 0 or 1
 *   node generate.mjs --out <dir>     write into <dir> instead of ./generated
 *
 * `--check` verifies the magic bytes, non-zero sizes and PDF page counts the contract names, and four
 * further properties that make those checks mean something: the PDF's text layer really carries the
 * running header and footer, the body/heading/footnote sizes and the hyphenated break; `scanned.pdf`
 * carries no text layer at all; `page.png` really is 1240x1754 with ink on it; and `expected.json`
 * agrees with the files it describes.
 *
 * The layout constants are load-bearing, not cosmetic. F§5.4 decides furniture from the top and bottom
 * 8% bands, headings from a font size of at least 1.25x the page median, and footnotes from a font
 * below 0.85x the median. The document is set as a double-spaced manuscript — 14pt type on 30pt
 * leading behind two-inch margins — which is both a plausible setting for this text and the one that
 * makes the fixture exactly five pages; heading 21pt (1.5x the body) and footnote 10pt are chosen so
 * all three F§5.4 tests decide the way the architecture says they must, and the running header (y=750)
 * and footer (y=36) sit inside their bands on all five pages while every body line stays between them.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(HERE, "source", "lighthouse.md");
const DEFAULT_OUT = join(HERE, "generated");
const USAGE = "Usage: node generate.mjs [--check] [--out <dir>]";

const EPUB_MIME = "application/epub+zip";
// fflate refuses `mtime: 0` ("date not in range 1980-2099"), so one fixed in-range stamp is used for
// every entry: the committed archives are then byte-reproducible instead of carrying the build clock.
const ZIP_STAMP = Date.UTC(1980, 0, 1);
// pdf-lib stamps /CreationDate and /ModDate from the wall clock, so both are pinned to this instant:
// without it the committed PDFs change on every run and the generated tree can never be re-verified.
const FIXED_DATE = new Date(ZIP_STAMP);
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const PRODUCER = "Lectern fixtures";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const TEXT_LEFT = 144;
const COLUMN_WIDTH = PAGE_WIDTH - TEXT_LEFT * 2;
const BODY_SIZE = 14;
const HEADING_SIZE = BODY_SIZE * 1.5;
const FOOTNOTE_SIZE = 10;
const FURNITURE_SIZE = 10;
const LEADING = 30;
const BODY_TOP = 700;
const BODY_BOTTOM = 110;
const HEADER_Y = 750;
const FOOTER_Y = 36;
const RULE_Y = 100;
const RULE_WIDTH = 200;
const FOOTNOTE_Y = 84;
const HEADER_TEXT = "Lighthouse Notes";
const FOOTER_PATTERN = "Page #";
const EXPECTED_PAGES = 5;
const SCANNED_PAGES = 2;
const FOOTNOTE_START = "1.";

const PAGE_IMAGE = { width: 1240, height: 1754, size: 28, margin: 96, leading: 40 };
const SCAN_IMAGE = { width: 1700, height: 2200, size: 30, margin: 120, leading: 44 };
const COVER_IMAGE = { width: 1024, height: 1024, size: 44, margin: 96, leading: 64 };

// Hyphenation points for the compounds the source uses. A word that does not fit is broken at the
// last point whose prefix still fits, which is what puts `light-` at the end of one line and `house`
// at the start of the next — the shape F§5.4's de-hyphenation rule acts on.
const HYPHENATION_POINTS = {
  automation: ["auto", "mation"],
  bonfires: ["bon", "fires"],
  clockwork: ["clock", "work"],
  concentric: ["con", "centric"],
  contractor: ["contrac", "tor"],
  decoration: ["deco", "ration"],
  driftwood: ["drift", "wood"],
  headland: ["head", "land"],
  horizontal: ["hori", "zontal"],
  lighthouse: ["light", "house"],
};

const SANS_PREFERENCE = ["Liberation Sans", "DejaVu Sans", "Noto Sans", "Nimbus Sans", "FreeSans", "Arial", "Helvetica"];

const REQUIRED_ARTEFACTS = [
  "sample.txt",
  "sample.md",
  "article.html",
  "text.pdf",
  "page.png",
  "scanned.pdf",
  "book.epub",
  "doc.docx",
  "expected.json",
];

// ---------------------------------------------------------------- source parsing

function stripInlineMarkers(text) {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1$2")
    .replace(/~~([^~\n]+)~~/g, "$1");
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?\u2026])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Parses the fixture source into blocks. A `1.`-style line is the footnote (the source carries exactly
 * one, at the end) — deliberately the marker form F§5.4's footnote rule looks for, and one the
 * Markdown reader would otherwise read as a list item, which is why the fixture keeps its three-item
 * list in chapter two rather than relying on the marker.
 */
function parseSource(markdown) {
  const document = { title: "", intro: [], chapters: [], footnote: null };
  let chapter = null;
  let paragraph = [];
  let list = null;
  let quote = null;

  const target = () => (chapter === null ? document.intro : chapter.blocks);
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const text = paragraph.join(" ").trim();
      if (text !== "") target().push({ kind: "paragraph", text: stripInlineMarkers(text) });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list !== null && list.length > 0) target().push({ kind: "list", items: list });
    list = null;
  };
  const flushQuote = () => {
    if (quote !== null && quote.length > 0) target().push({ kind: "quote", text: quote.join(" ") });
    quote = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const level = heading[1].length;
      const text = stripInlineMarkers(heading[2].trim());
      if (level === 1) document.title = text;
      else {
        chapter = { title: text, level, blocks: [] };
        document.chapters.push(chapter);
      }
      continue;
    }
    const footnote = /^(\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (footnote !== null) {
      flushAll();
      document.footnote = { marker: footnote[1], text: stripInlineMarkers(line.trim()) };
      continue;
    }
    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (listItem !== null) {
      flushParagraph();
      flushQuote();
      if (list === null) list = [];
      list.push(stripInlineMarkers(listItem[1].trim()));
      continue;
    }
    const quoteLine = /^>\s?(.*)$/.exec(line);
    if (quoteLine !== null) {
      flushParagraph();
      flushList();
      if (quote === null) quote = [];
      quote.push(stripInlineMarkers(quoteLine[1].trim()));
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flushAll();
  return document;
}

/** The source as plain text: the same block markers the Markdown keeps (F§5.4 reads both the same way), inline markers removed. */
function renderPlainText(document) {
  const parts = [];
  if (document.title !== "") parts.push(`# ${document.title}`);
  parts.push(...document.intro.map((block) => block.text));
  for (const chapter of document.chapters) {
    parts.push(`${"#".repeat(chapter.level)} ${chapter.title}`);
    for (const block of chapter.blocks) {
      if (block.kind === "paragraph") parts.push(block.text);
      else if (block.kind === "list") parts.push(block.items.map((item) => `- ${item}`).join("\n"));
      else parts.push(`> ${block.text}`);
    }
  }
  if (document.footnote !== null) parts.push(document.footnote.text);
  return `${parts.join("\n\n")}\n`;
}

/**
 * The generator owns its source format, so a source that cannot yield every artefact is reported as a
 * list of problems rather than crashed on — the same list fails both `--check` and a plain generate.
 */
function sourceProblems(source, document) {
  const problems = [];
  if (document.title === "") problems.push("the source has no level-1 title");
  if (document.chapters.length < 2) {
    problems.push(`the source has ${document.chapters.length} chapter(s), and the DOCX fixture needs at least 2`);
  }
  if (document.footnote === null) problems.push("the source has no footnote line (a trailing `1. …` paragraph)");
  const blocks = document.chapters.flatMap((chapter) => chapter.blocks);
  const items = blocks.reduce((total, block) => total + (block.kind === "list" ? block.items.length : 0), 0);
  if (items !== 3) problems.push(`the source carries ${items} list item(s), expected 3`);
  const quotes = blocks.filter((block) => block.kind === "quote").length;
  if (quotes !== 1) problems.push(`the source carries ${quotes} block quote(s), expected 1`);
  const words = wordCount(source);
  if (words < 700 || words > 900) problems.push(`the source is ${words} words, expected 700-900`);
  return problems;
}

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

function chapterTexts(document) {
  const titles = [];
  const firstSentences = [];
  for (const chapter of document.chapters) {
    titles.push(chapter.title);
    const first = chapter.blocks.find((block) => block.kind === "paragraph");
    firstSentences.push(first === undefined ? "" : (splitSentences(first.text)[0] ?? ""));
  }
  return { titles, firstSentences };
}

// ---------------------------------------------------------------- text layout

function resolveSansFamily() {
  const families = GlobalFonts.families;
  if (families.length === 0) {
    throw new Error("@napi-rs/canvas reports zero available font families; refusing to write blank images");
  }
  for (const family of SANS_PREFERENCE) {
    if (GlobalFonts.has(family)) return family;
  }
  return families[0].family;
}

function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current !== "") lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function hyphenationCandidates(word) {
  const segments = HYPHENATION_POINTS[word.toLowerCase()];
  if (segments === undefined || segments.length < 2) return [];
  const candidates = [];
  let length = 0;
  for (let index = 0; index < segments.length - 1; index += 1) {
    length += segments[index].length;
    candidates.push({ head: `${word.slice(0, length)}-`, rest: word.slice(length) });
  }
  return candidates;
}

/** Wraps with the PDF's real font metrics and breaks a word at a hyphenation point when only part of it fits the rest of the line. */
function wrapPdfText(font, size, text, maxWidth) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current === "") {
      lines.push(word);
      continue;
    }
    const broken = hyphenationCandidates(word).find((entry) => font.widthOfTextAtSize(`${current} ${entry.head}`, size) <= maxWidth);
    if (broken === undefined) {
      lines.push(current);
      current = word;
    } else {
      lines.push(`${current} ${broken.head}`);
      current = broken.rest;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Block list -> the line sequence the PDF flow places, with heading sizes and paragraph gaps marked. */
function layoutItems(document, font) {
  const items = [];
  const pushParagraph = (text) => {
    for (const line of wrapPdfText(font, BODY_SIZE, text, COLUMN_WIDTH)) {
      items.push({ kind: "line", text: line, size: BODY_SIZE });
    }
    items.push({ kind: "gap" });
  };
  const pushBlocks = (blocks) => {
    for (const block of blocks) {
      if (block.kind === "paragraph") {
        pushParagraph(block.text);
        continue;
      }
      if (block.kind === "list") {
        for (const item of block.items) {
          wrapPdfText(font, BODY_SIZE, item, COLUMN_WIDTH - 18).forEach((line, index) => {
            items.push({ kind: "line", text: index === 0 ? `- ${line}` : line, size: BODY_SIZE });
          });
        }
      } else {
        for (const line of wrapPdfText(font, BODY_SIZE, block.text, COLUMN_WIDTH - 18)) {
          items.push({ kind: "line", text: line, size: BODY_SIZE });
        }
      }
      items.push({ kind: "gap" });
    }
  };

  for (const block of document.intro) pushParagraph(block.text);
  for (const chapter of document.chapters) {
    items.push({ kind: "heading", text: chapter.title, size: HEADING_SIZE });
    pushBlocks(chapter.blocks);
  }
  return items;
}

// ---------------------------------------------------------------- PDF artefacts

async function buildTextPdf(document) {
  const pdf = await PDFDocument.create();
  pdf.setProducer(PRODUCER);
  pdf.setCreator(PRODUCER);
  pdf.setTitle(HEADER_TEXT);
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = [];
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = BODY_TOP;
  for (const item of layoutItems(document, body)) {
    if (item.kind === "gap") {
      y -= LEADING / 2;
      continue;
    }
    const advance = item.kind === "heading" ? LEADING * 1.2 : LEADING;
    if (y - advance < BODY_BOTTOM) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pages.push(page);
      y = BODY_TOP;
    }
    page.drawText(item.text, {
      x: TEXT_LEFT,
      y: y - advance + LEADING * 0.25,
      size: item.size,
      font: item.kind === "heading" ? bold : body,
      color: rgb(0, 0, 0),
    });
    y -= advance;
  }

  const grey = rgb(0.2, 0.2, 0.2);
  pages.forEach((item, index) => {
    item.drawText(HEADER_TEXT, { x: TEXT_LEFT, y: HEADER_Y, size: FURNITURE_SIZE, font: body, color: grey });
    item.drawText(`Page ${index + 1}`, { x: PAGE_WIDTH - TEXT_LEFT - 26, y: FOOTER_Y, size: FURNITURE_SIZE, font: body, color: grey });
  });

  const last = pages[pages.length - 1];
  if (document.footnote !== null) {
    last.drawRectangle({ x: TEXT_LEFT, y: RULE_Y, width: RULE_WIDTH, height: 0.7, color: rgb(0, 0, 0) });
    last.drawText(document.footnote.text, { x: TEXT_LEFT, y: FOOTNOTE_Y, size: FOOTNOTE_SIZE, font: body, color: rgb(0, 0, 0) });
  }

  return { bytes: await pdf.save({ useObjectStreams: false }), pageCount: pdf.getPageCount() };
}

async function buildScannedPdf(document) {
  const pdf = await PDFDocument.create();
  pdf.setProducer(PRODUCER);
  pdf.setCreator(PRODUCER);
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const chapterBlocks = document.chapters.map((chapter) => ({
    text: [chapter.title, ...chapter.blocks.filter((block) => block.kind === "paragraph").map((block) => block.text)].join("\n\n"),
  }));
  for (let index = 0; index < SCANNED_PAGES; index += 1) {
    const image = await pdf.embedPng(renderTextImage(SCAN_IMAGE, [chapterBlocks[Math.min(index, chapterBlocks.length - 1)]]).png);
    pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]).drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }
  return { bytes: await pdf.save({ useObjectStreams: false }), pageCount: pdf.getPageCount() };
}

// ---------------------------------------------------------------- raster artefacts

/** Renders body text into a black-on-white image and reports the words that were actually drawn. */
function renderTextImage(layout, blocks) {
  const family = resolveSansFamily();
  const canvas = createCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = "#000000";
  const maxWidth = layout.width - layout.margin * 2;
  const words = [];
  let y = layout.margin + layout.size;
  for (const block of blocks) {
    const size = block.size ?? layout.size;
    const limit = y > layout.height - layout.margin;
    if (limit) break;
    ctx.font = `${size}px ${family}`;
    for (const line of wrapCanvasText(ctx, block.text, size === layout.size ? maxWidth : maxWidth - layout.size)) {
      if (y > layout.height - layout.margin) break;
      ctx.fillText(line, layout.margin, y);
      for (const word of line.split(/\s+/)) if (word !== "") words.push(word);
      y += layout.leading;
    }
    y += layout.leading / 2;
  }
  return { png: canvas.toBuffer("image/png"), words, family };
}

/** Counts dark pixels, so "black on white" and "not blank" are measured rather than assumed. */
function countInk(image) {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let dark = 0;
  for (let index = 0; index < data.length; index += 4) if (data[index] < 128) dark += 1;
  return dark;
}

// ---------------------------------------------------------------- container artefacts

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeHtml(text) {
  return escapeXml(text).replace(/'/g, "&#39;");
}

/** One ZIP writer for both containers: the first entry may be stored, every entry carries the same stamp. */
function zipEntries(entries) {
  const input = {};
  for (const entry of entries) {
    const data = typeof entry.text === "string" ? strToU8(entry.text) : entry.bytes;
    input[entry.name] = [data, { level: entry.stored === true ? 0 : 9, mtime: ZIP_STAMP }];
  }
  return zipSync(input, { level: 6, mtime: ZIP_STAMP });
}

function xhtmlDocument(titleText, body) {
  return `${XML_HEADER}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
  <head>
    <title>${escapeXml(titleText)}</title>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function buildEpub(document, coverPng) {
  const chapters = document.chapters;
  const container = `${XML_HEADER}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    '    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>',
    ...chapters.map(
      (_chapter, index) => `    <item id="chapter-${index + 1}" href="chapter-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`,
    ),
  ];
  const opf = `${XML_HEADER}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:lectern-fixture-lighthouse-notes</dc:identifier>
    <dc:title>${escapeXml(document.title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>${PRODUCER}</dc:creator>
    <meta property="dcterms:modified">1980-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine>
${chapters.map((_chapter, index) => `    <itemref idref="chapter-${index + 1}"/>`).join("\n")}
  </spine>
</package>
`;
  const nav = xhtmlDocument(
    "Contents",
    `    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
${chapters.map((chapter, index) => `        <li><a href="chapter-${index + 1}.xhtml">${escapeXml(chapter.title)}</a></li>`).join("\n")}
      </ol>
    </nav>`,
  );
  const cover = xhtmlDocument(document.title, `    <div class="cover"><img src="cover.png" alt="${escapeHtml(document.title)}"/></div>`);
  const chapterDocuments = chapters.map((chapter) => {
    const body = [`    <h2>${escapeXml(chapter.title)}</h2>`];
    for (const block of chapter.blocks) {
      if (block.kind === "paragraph") body.push(`    <p>${escapeXml(block.text)}</p>`);
      else if (block.kind === "list") body.push("    <ul>", ...block.items.map((item) => `      <li>${escapeXml(item)}</li>`), "    </ul>");
      else body.push(`    <blockquote><p>${escapeXml(block.text)}</p></blockquote>`);
    }
    return xhtmlDocument(chapter.title, body.join("\n"));
  });

  return zipEntries([
    { name: "mimetype", text: EPUB_MIME, stored: true },
    { name: "META-INF/container.xml", text: container },
    { name: "OEBPS/content.opf", text: opf },
    { name: "OEBPS/nav.xhtml", text: nav },
    { name: "OEBPS/cover.xhtml", text: cover },
    ...chapterDocuments.map((text, index) => ({ name: `OEBPS/chapter-${index + 1}.xhtml`, text })),
    { name: "OEBPS/cover.png", bytes: coverPng },
  ]);
}

function docxParagraph(text, style, numbered) {
  const properties = [];
  if (style !== undefined) properties.push(`<w:pStyle w:val="${style}"/>`);
  if (numbered === true) properties.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  const pPr = properties.length === 0 ? "" : `<w:pPr>${properties.join("")}</w:pPr>`;
  return `  <w:p>${pPr}<w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** Title, two headings, paragraphs and one real numbered list — the parts F§5.4's DOCX row must map. */
function buildDocx(document) {
  const first = document.chapters[0];
  const second = document.chapters[1];
  const body = [
    docxParagraph(document.title, "Title"),
    docxParagraph(first.title, "Heading1"),
    ...first.blocks.filter((block) => block.kind === "paragraph").map((block) => docxParagraph(block.text)),
    docxParagraph(second.title, "Heading2"),
    ...second.blocks
      .filter((block) => block.kind === "paragraph")
      .slice(0, 2)
      .map((block) => docxParagraph(block.text)),
    ...second.blocks.flatMap((block) =>
      block.kind === "list" ? block.items.map((item) => docxParagraph(item, "ListParagraph", true)) : [],
    ),
    '  <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  ].join("\n");
  const documentXml = `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
</w:body>
</w:document>
`;
  const contentTypes = `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
`;
  const rootRels = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
`;
  const documentRels = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>
`;
  const coreProperties = `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(document.title)}</dc:title>
  <dc:creator>${PRODUCER}</dc:creator>
  <cp:lastModifiedBy>${PRODUCER}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:created>
</cp:coreProperties>
`;
  const style = (id, name, halfPoints, bold) =>
    `  <w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${halfPoints}"/></w:rPr></w:style>`;
  const styles = `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
${style("Title", "Title", 36, true)}
${style("Heading1", "heading 1", 32, true)}
${style("Heading2", "heading 2", 28, true)}
${style("ListParagraph", "List Paragraph", 24, false)}
</w:styles>
`;
  const numbering = `${XML_HEADER}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>
`;
  return zipEntries([
    { name: "[Content_Types].xml", text: contentTypes },
    { name: "_rels/.rels", text: rootRels },
    { name: "docProps/core.xml", text: coreProperties },
    { name: "word/document.xml", text: documentXml },
    { name: "word/_rels/document.xml.rels", text: documentRels },
    { name: "word/styles.xml", text: styles },
    { name: "word/numbering.xml", text: numbering },
  ]);
}

// ---------------------------------------------------------------- article

function buildArticle(document) {
  const sections = document.chapters.map((chapter, index) => {
    const body = [];
    for (const block of chapter.blocks) {
      if (block.kind === "paragraph") body.push(`        <p>${escapeHtml(block.text)}</p>`);
      else if (block.kind === "list") {
        body.push("        <ul>", ...block.items.map((item) => `          <li>${escapeHtml(item)}</li>`), "        </ul>");
      } else body.push(`        <blockquote>${escapeHtml(block.text)}</blockquote>`);
    }
    return `      <section id="chapter-${index + 1}">
        <h2>${escapeHtml(chapter.title)}</h2>
${body.join("\n")}
      </section>`;
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <title>${escapeHtml(document.title)}</title>
  </head>
  <body>
    <nav aria-label="Chapters">
      <ul>
${document.chapters.map((chapter, index) => `        <li><a href="#chapter-${index + 1}">${escapeHtml(chapter.title)}</a></li>`).join("\n")}
      </ul>
    </nav>
    <main>
      <h1>${escapeHtml(document.title)}</h1>
${document.intro.map((block) => `      <p>${escapeHtml(block.text)}</p>`).join("\n")}
${sections.join("\n")}
    </main>
    <aside>
      <h2>Fixture notes</h2>
      <p>Original prose written for the Lectern parser tests. Nothing here is quoted from another work.</p>
    </aside>
    <footer>
      <p>${PRODUCER}</p>
    </footer>
  </body>
</html>
`;
}

// ---------------------------------------------------------------- artefact assembly

async function buildArtefacts(source, document) {
  const { titles, firstSentences } = chapterTexts(document);
  const textPdf = await buildTextPdf(document);

  const pageBlocks = [];
  if (document.title !== "") pageBlocks.push({ text: document.title, size: PAGE_IMAGE.size * 1.5 });
  pageBlocks.push(...document.chapters[0].blocks.filter((block) => block.kind === "paragraph").map((block) => ({ text: block.text })));
  const pageImage = renderTextImage(PAGE_IMAGE, pageBlocks);

  const scanned = await buildScannedPdf(document);
  const cover = renderTextImage(COVER_IMAGE, [
    { text: document.title, size: 88 },
    { text: PRODUCER, size: 36 },
  ]);

  const expected = {
    title: document.title,
    chapterTitles: titles,
    firstSentenceOfChapter: firstSentences,
    headerText: HEADER_TEXT,
    footerPattern: FOOTER_PATTERN,
    footnoteStart: FOOTNOTE_START,
    dehyphenatedWord: "lighthouse",
    pageImageWords: pageImage.words,
  };

  return {
    artefacts: [
      { name: "sample.txt", text: renderPlainText(document) },
      { name: "sample.md", text: source },
      { name: "article.html", text: buildArticle(document) },
      { name: "text.pdf", bytes: textPdf.bytes },
      { name: "page.png", bytes: pageImage.png },
      { name: "scanned.pdf", bytes: scanned.bytes },
      { name: "book.epub", bytes: buildEpub(document, cover.png) },
      { name: "doc.docx", bytes: buildDocx(document) },
      { name: "expected.json", text: `${JSON.stringify(expected, null, 2)}\n` },
    ],
    expected,
    textPdf,
    scanned,
    pageImage,
  };
}

// ---------------------------------------------------------------- PDF inspection

function decodeStreams(bytes) {
  const latin = Buffer.from(bytes).toString("latin1");
  const streams = [];
  let index = 0;
  for (;;) {
    const start = latin.indexOf("stream", index);
    if (start === -1) return streams;
    if (latin.slice(Math.max(0, start - 5), start).endsWith("end")) {
      index = start + 6;
      continue;
    }
    let from = start + 6;
    if (latin[from] === "\r") from += 1;
    if (latin[from] === "\n") from += 1;
    const end = latin.indexOf("endstream", from);
    if (end === -1) return streams;
    const chunk = Buffer.from(bytes).subarray(from, end);
    let decoded;
    try {
      decoded = inflateSync(chunk);
    } catch {
      decoded = chunk;
    }
    streams.push(decoded.toString("latin1"));
    index = end + 9;
  }
}

/** Content streams are ASCII text operators; an embedded image is a stream of binary and is not one. */
function isTextStream(stream) {
  if (stream.length === 0) return false;
  let printable = 0;
  for (let index = 0; index < stream.length; index += 1) {
    const code = stream.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) printable += 1;
  }
  return printable / stream.length > 0.95;
}

function hexToText(hex) {
  let text = "";
  for (let index = 0; index + 1 < hex.length; index += 2) text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  return text;
}

/** The text layer, read back out of the inflated content streams (pdf-lib writes `<hex> Tj`). */
function pdfTextLines(bytes) {
  const lines = [];
  for (const stream of decodeStreams(bytes)) {
    if (!isTextStream(stream)) continue;
    for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) lines.push(hexToText(match[1]));
  }
  return lines;
}

function pdfFontSizes(bytes) {
  const sizes = new Set();
  for (const stream of decodeStreams(bytes)) {
    if (!isTextStream(stream)) continue;
    for (const match of stream.matchAll(/\/[^\s/]+\s+([\d.]+)\s+Tf/g)) sizes.add(Number.parseFloat(match[1]));
  }
  return [...sizes].sort((left, right) => left - right);
}

// ---------------------------------------------------------------- check mode

async function collectProblems(document, produced) {
  const problems = [];
  const expect = (condition, message) => {
    if (!condition) problems.push(message);
  };
  const byName = new Map(produced.artefacts.map((entry) => [entry.name, entry]));
  const bytesOf = (name) => {
    const entry = byName.get(name);
    if (entry === undefined) return null;
    return entry.bytes ?? strToU8(entry.text ?? "");
  };
  const hasSignature = (name, offset, latin) => {
    const bytes = bytesOf(name);
    return (
      bytes !== null &&
      Buffer.from(bytes)
        .subarray(offset, offset + latin.length)
        .toString("latin1") === latin
    );
  };

  expect(
    produced.artefacts.length === REQUIRED_ARTEFACTS.length,
    `built ${produced.artefacts.length} artefacts, expected ${REQUIRED_ARTEFACTS.length}`,
  );
  for (const name of REQUIRED_ARTEFACTS) {
    const bytes = bytesOf(name);
    expect(bytes !== null, `${name} was not produced`);
    if (bytes !== null) expect(bytes.length > 0, `${name} is empty`);
  }
  expect(hasSignature("text.pdf", 0, "%PDF"), "text.pdf does not start with %PDF");
  expect(hasSignature("scanned.pdf", 0, "%PDF"), "scanned.pdf does not start with %PDF");
  expect(hasSignature("page.png", 1, "PNG"), "page.png does not carry the PNG signature");
  expect(hasSignature("book.epub", 0, "PK"), "book.epub is not a ZIP container");
  expect(hasSignature("doc.docx", 0, "PK"), "doc.docx is not a ZIP container");

  // text.pdf: page count, furniture on every page, the three sizes, the hyphenated break, the footnote.
  expect(produced.textPdf.pageCount === EXPECTED_PAGES, `text.pdf has ${produced.textPdf.pageCount} page(s), expected ${EXPECTED_PAGES}`);
  const textBytes = bytesOf("text.pdf");
  if (textBytes !== null) {
    const lines = pdfTextLines(textBytes);
    const headers = lines.filter((line) => line === HEADER_TEXT).length;
    expect(headers === EXPECTED_PAGES, `the running header appears ${headers} time(s), expected ${EXPECTED_PAGES}`);
    for (let number = 1; number <= EXPECTED_PAGES; number += 1) {
      const count = lines.filter((line) => line === `Page ${number}`).length;
      expect(count === 1, `the footer "Page ${number}" appears ${count} time(s), expected 1`);
    }
    expect(
      lines.some((line) => line.includes("light-") && line.endsWith("light-")),
      "no line ends in the hyphenated break (light-)",
    );
    const breakIndex = lines.findIndex((line) => line.endsWith("light-"));
    expect(
      breakIndex >= 0 && /^[a-z]/.test(lines[breakIndex + 1] ?? ""),
      "the line after the hyphenated break does not start with a lowercase letter",
    );
    expect(
      lines.some((line) => line.startsWith(FOOTNOTE_START)),
      "the footnote marker is not in the text layer",
    );
    const sizes = pdfFontSizes(textBytes);
    expect(sizes.includes(BODY_SIZE), `the body size ${BODY_SIZE} is not in the text layer (found: ${sizes.join(", ")})`);
    expect(sizes.includes(HEADING_SIZE), `the heading size ${HEADING_SIZE} is not in the text layer (found: ${sizes.join(", ")})`);
    expect(sizes.includes(FOOTNOTE_SIZE), `the footnote size ${FOOTNOTE_SIZE} is not in the text layer (found: ${sizes.join(", ")})`);
    expect(HEADING_SIZE === BODY_SIZE * 1.5, "chapter headings are not 1.5x the body size");
    expect(FOOTNOTE_SIZE < BODY_SIZE * 0.85, "the footnote is not smaller than 0.85x the body size");
    expect(BODY_TOP < PAGE_HEIGHT * 0.92 && BODY_BOTTOM > PAGE_HEIGHT * 0.08, "a body line is inside a furniture band");
    expect(HEADER_Y >= PAGE_HEIGHT * 0.92, "the running header is not inside the top 8% band");
    expect(FOOTER_Y <= PAGE_HEIGHT * 0.08, "the running footer is not inside the bottom 8% band");
  }

  // scanned.pdf: two pages, no text layer.
  expect(produced.scanned.pageCount === SCANNED_PAGES, `scanned.pdf has ${produced.scanned.pageCount} page(s), expected ${SCANNED_PAGES}`);
  const scannedBytes = bytesOf("scanned.pdf");
  if (scannedBytes !== null) expect(pdfTextLines(scannedBytes).length === 0, "scanned.pdf carries a text layer");

  // page.png: exact dimensions and real ink.
  const pngBytes = bytesOf("page.png");
  if (pngBytes !== null) {
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    expect(view.getUint32(16) === PAGE_IMAGE.width, `page.png is ${view.getUint32(16)} px wide, expected ${PAGE_IMAGE.width}`);
    expect(view.getUint32(20) === PAGE_IMAGE.height, `page.png is ${view.getUint32(20)} px tall, expected ${PAGE_IMAGE.height}`);
    expect(countInk(await loadImage(Buffer.from(pngBytes))) > 0, "page.png is blank (no dark pixels)");
  }

  // book.epub: mimetype first and stored, container, three-chapter spine, nav and cover.
  const epubBytes = bytesOf("book.epub");
  if (epubBytes !== null) {
    const view = new DataView(epubBytes.buffer, epubBytes.byteOffset, epubBytes.byteLength);
    const nameLength = view.getUint16(26, true);
    const firstName = Buffer.from(epubBytes.subarray(30, 30 + nameLength)).toString("latin1");
    expect(firstName === "mimetype", `the first EPUB entry is ${firstName}, expected mimetype`);
    expect(view.getUint16(8, true) === 0, "the EPUB mimetype entry is compressed, expected stored");
    const entries = unzipSync(epubBytes);
    expect(strFromU8(entries.mimetype ?? new Uint8Array()) === EPUB_MIME, "the EPUB mimetype content is wrong");
    for (const part of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/cover.xhtml"]) {
      expect(part in entries, `book.epub is missing ${part}`);
    }
    const opf = strFromU8(entries["OEBPS/content.opf"] ?? new Uint8Array());
    const spine = (opf.match(/<itemref /g) ?? []).length;
    expect(spine === document.chapters.length, `the OPF spine lists ${spine} item(s), expected ${document.chapters.length}`);
    expect(opf.includes('properties="nav"'), "the OPF declares no navigation document");
    expect(opf.includes('properties="cover-image"'), "the OPF declares no cover image");
  }

  // doc.docx: a title, two headings, paragraphs and a real three-item numbered list.
  const docxBytes = bytesOf("doc.docx");
  if (docxBytes !== null) {
    const entries = unzipSync(docxBytes);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/numbering.xml",
    ]) {
      expect(part in entries, `doc.docx is missing ${part}`);
    }
    const body = strFromU8(entries["word/document.xml"] ?? new Uint8Array());
    expect(body.includes('w:val="Title"'), "doc.docx has no title paragraph");
    const headings = (body.match(/w:val="Heading1"|w:val="Heading2"/g) ?? []).length;
    expect(headings === 2, `doc.docx carries ${headings} heading(s), expected 2`);
    const numbered = (body.match(/<w:numPr>/g) ?? []).length;
    expect(numbered === 3, `doc.docx carries ${numbered} numbered list item(s), expected 3`);
    expect(body.includes(escapeXml(document.title)), "doc.docx does not contain the title text");
  }

  // The two text artefacts differ exactly in the inline markers the Markdown keeps.
  const markdown = byName.get("sample.md")?.text ?? "";
  const plain = byName.get("sample.txt")?.text ?? "";
  expect(markdown.includes("*not*"), "the Markdown source carries no inline emphasis to strip");
  expect(!plain.includes("*"), "the plain-text rendition kept inline markers");

  // expected.json agrees with the source and with the artefacts it describes.
  const expectedBytes = bytesOf("expected.json");
  if (expectedBytes !== null) {
    const parsed = JSON.parse(strFromU8(expectedBytes));
    const { titles, firstSentences } = chapterTexts(document);
    expect(parsed.title === document.title, "expected.json title disagrees with the source");
    expect(JSON.stringify(parsed.chapterTitles) === JSON.stringify(titles), "expected.json chapterTitles disagree with the source");
    expect(
      JSON.stringify(parsed.firstSentenceOfChapter) === JSON.stringify(firstSentences),
      "expected.json first sentences disagree with the source",
    );
    expect(parsed.headerText === HEADER_TEXT, "expected.json headerText disagrees with the running header");
    expect(parsed.footerPattern === FOOTER_PATTERN, "expected.json footerPattern is not the digit-substituted footer");
    expect(parsed.footnoteStart === document.footnote?.marker, "expected.json footnoteStart disagrees with the source footnote");
    expect(
      JSON.stringify(parsed.pageImageWords) === JSON.stringify(produced.pageImage.words),
      "expected.json pageImageWords disagree with page.png",
    );
    expect(produced.pageImage.words.includes(parsed.dehyphenatedWord), "the de-hyphenated word is not drawn into page.png");
    for (const title of parsed.chapterTitles)
      expect(produced.pageImage.words.includes(title) || plain.includes(title), `chapter title "${title}" is missing from the artefacts`);
  }

  return problems;
}

/** Two builds of the same source must be byte-identical, or the committed fixtures can never be verified. */
function reproducibilityProblems(produced, rebuilt) {
  const problems = [];
  const other = new Map(rebuilt.artefacts.map((entry) => [entry.name, entry]));
  for (const artefact of produced.artefacts) {
    const again = other.get(artefact.name);
    const left = artefact.bytes ?? strToU8(artefact.text ?? "");
    const right = again?.bytes ?? strToU8(again?.text ?? "");
    if (left.length !== right.length || !Buffer.from(left).equals(Buffer.from(right))) {
      problems.push(`${artefact.name} is not reproducible: two builds of the same source differ`);
    }
  }
  return problems;
}

async function runCheck(source, document) {
  const temp = await mkdtemp(join(tmpdir(), "lectern-fixtures-"));
  try {
    const produced = await buildArtefacts(source, document);
    for (const artefact of produced.artefacts) {
      await writeFile(join(temp, artefact.name), artefact.bytes ?? strToU8(artefact.text ?? ""));
    }
    const problems = [
      ...(await collectProblems(document, produced)),
      ...reproducibilityProblems(produced, await buildArtefacts(source, document)),
    ];
    const words = wordCount(source);
    if (problems.length > 0) {
      process.stderr.write(`check: ${problems.length} problem(s) in the generated fixtures\n`);
      for (const problem of problems) process.stderr.write(`  ${problem}\n`);
      return 1;
    }
    process.stdout.write(
      `check: ok — ${produced.artefacts.length} artefact(s), text.pdf ${produced.textPdf.pageCount} pages, scanned.pdf ${produced.scanned.pageCount} pages, source ${words} words\n`,
    );
    return 0;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- entry point

function parseArguments(argv) {
  let out = null;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") check = true;
    else if (argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value === "") return { error: "--out needs a directory" };
      out = value;
      index += 1;
    } else if (argument !== "") return { error: `Unexpected argument: ${argument}` };
  }
  return { check, out };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.error !== undefined) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 1;
  }
  const source = await readFile(SOURCE_PATH, "utf8");
  const document = parseSource(source);
  const issues = sourceProblems(source, document);
  if (issues.length > 0) {
    process.stderr.write(`source: ${issues.length} problem(s) in source/lighthouse.md\n`);
    for (const issue of issues) process.stderr.write(`  ${issue}\n`);
    return 1;
  }
  if (options.check === true) return runCheck(source, document);
  const outDir = options.out ?? DEFAULT_OUT;
  const produced = await buildArtefacts(source, document);
  await mkdir(outDir, { recursive: true });
  for (const artefact of produced.artefacts) {
    await writeFile(join(outDir, artefact.name), artefact.bytes ?? strToU8(artefact.text ?? ""));
  }
  process.stdout.write(`generate: wrote ${produced.artefacts.length} file(s) into ${outDir}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
