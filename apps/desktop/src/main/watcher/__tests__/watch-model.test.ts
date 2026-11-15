/**
 * What a watched folder's contents mean, on its own (F§10.3).
 *
 * `./watch-model` is the whole of this feature's decisions — which names are documents, how one reading of one
 * file is remembered, and what type a document is handed over as — and every one of them is a case below. The
 * module reads no disk and holds no clock, so these are the names and the numbers themselves rather than
 * anything a running shell has to produce; the end-to-end case in `apps/desktop/e2e/watcher.spec.ts` is what
 * proves the watcher around them.
 *
 * The extensions and the two expected MIME types are written out here rather than read from the module, so a
 * table that drifts from F§10.3 fails rather than agreeing with itself.
 */

import { describe, expect, it } from "vitest";
import {
  FALLBACK_MIME,
  fileKey,
  IMPORTABLE_EXTENSIONS,
  isImportable,
  MAX_IMPORT_BYTES,
  mimeForExtension,
  shouldProcess,
} from "../watch-model";

/** What F§10.3's six extensions are handed over as, in F§10.3's own order. */
const EXPECTED_MIME: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
};

/** A file of one megabyte: inside every rule the shell has, so only the name decides. */
const ORDINARY_BYTES = 1024 * 1024;

describe("isImportable", () => {
  it("takes each of the six extensions F§10.3 names", () => {
    for (const extension of IMPORTABLE_EXTENSIONS) {
      expect(isImportable(`/home/reader/Lectern/Inbox/report.${extension}`, ORDINARY_BYTES), extension).toBe(true);
    }
  });

  it("folds case, because a name can arrive written the other way", () => {
    expect(isImportable("/watched/Report.PDF", ORDINARY_BYTES)).toBe(true);
    expect(isImportable("/watched/Report.Docx", ORDINARY_BYTES)).toBe(true);
    expect(isImportable("/watched/REPORT.MD", ORDINARY_BYTES)).toBe(true);
  });

  it("reads the last extension, so a name that remembers what it was is still taken", () => {
    expect(isImportable("/watched/chapter.md.txt", ORDINARY_BYTES)).toBe(true);
  });

  it("leaves a file whose extension the shell does not import", () => {
    for (const name of ["report.zip", "report.png", "report.exe", "report", "report.", "reportd"]) {
      expect(isImportable(`/watched/${name}`, ORDINARY_BYTES), name).toBe(false);
    }
  });

  it("leaves a hidden file alone, whatever it is called", () => {
    expect(isImportable("/watched/.notes.pdf", ORDINARY_BYTES)).toBe(false);
    expect(isImportable("/watched/.pdf", ORDINARY_BYTES)).toBe(false);
    expect(isImportable("/watched/.hidden.txt", ORDINARY_BYTES)).toBe(false);
  });

  it("leaves a partial download alone, in each of the three suffixes the contract names", () => {
    for (const suffix of [".crdownload", ".part", ".tmp"]) {
      expect(isImportable(`/watched/report.pdf${suffix}`, ORDINARY_BYTES), suffix).toBe(false);
    }
    expect(isImportable("/watched/x.pdf.part", ORDINARY_BYTES)).toBe(false);
    expect(isImportable("/watched/report.PDF.PART", ORDINARY_BYTES)).toBe(false);
  });

  it("leaves the marker a word processor writes beside a document it has open alone", () => {
    expect(isImportable("/watched/~$report.docx", ORDINARY_BYTES)).toBe(false);
    expect(isImportable("/watched/~$report.pdf", ORDINARY_BYTES)).toBe(false);
  });

  it("takes a file whose *parent* directory is hidden: only the file's own name is read", () => {
    expect(isImportable("/watched/.cache/report.pdf", ORDINARY_BYTES)).toBe(true);
  });
});

describe("the size limit", () => {
  it("takes a file of exactly the contract's 100 MB and refuses the byte past it", () => {
    expect(isImportable("/watched/report.pdf", MAX_IMPORT_BYTES)).toBe(true);
    expect(isImportable("/watched/report.pdf", MAX_IMPORT_BYTES + 1)).toBe(false);
  });

  it("takes an empty file, because what there is to read is the reader's decision, not the watcher's", () => {
    expect(isImportable("/watched/empty.txt", 0)).toBe(true);
  });

  it("refuses a size that is not a byte count at all", () => {
    expect(isImportable("/watched/report.pdf", Number.NaN)).toBe(false);
    expect(isImportable("/watched/report.pdf", Number.POSITIVE_INFINITY)).toBe(false);
    expect(isImportable("/watched/report.pdf", -1)).toBe(false);
  });
});

describe("mimeForExtension", () => {
  it("answers the type of each of the six, with or without its dot and in either case", () => {
    for (const extension of IMPORTABLE_EXTENSIONS) {
      expect(mimeForExtension(extension), extension).toBe(EXPECTED_MIME[extension]);
      expect(mimeForExtension(`.${extension}`), extension).toBe(EXPECTED_MIME[extension]);
      expect(mimeForExtension(extension.toUpperCase()), extension).toBe(EXPECTED_MIME[extension]);
    }
  });

  it("answers the generic type for an extension it does not know", () => {
    expect(mimeForExtension("zip")).toBe(FALLBACK_MIME);
    expect(mimeForExtension("")).toBe(FALLBACK_MIME);
    expect(mimeForExtension(".")).toBe(FALLBACK_MIME);
  });
});

describe("the key of one reading of one file", () => {
  const path = "/watched/report.pdf";
  const size = 2048;
  const mtimeMs = 1_763_000_000_123;
  const key = fileKey(path, size, mtimeMs);

  it("is the same for the same path, size and time, and different for each of the three moved", () => {
    expect(fileKey(path, size, mtimeMs)).toBe(key);
    expect(fileKey("/watched/other.pdf", size, mtimeMs)).not.toBe(key);
    expect(fileKey(path, size + 1, mtimeMs)).not.toBe(key);
    expect(fileKey(path, size, mtimeMs + 1)).not.toBe(key);
  });

  it("keeps the path, so a key in the shell's own record says what it is a key of", () => {
    expect(key).toContain(path);
  });

  it("truncates the time to whole milliseconds, the resolution the ledger keeps", () => {
    expect(fileKey(path, size, mtimeMs + 0.87)).toBe(key);
  });

  it("cannot be shared by accident: the path comes last, so a number cannot be read as part of it", () => {
    expect(fileKey("/watched/12", 3, 4)).not.toBe(fileKey("/watched/1", 23, 4));
  });
});

describe("shouldProcess", () => {
  const path = "/watched/report.pdf";
  const key = fileKey(path, 2048, 1_763_000_000_123);

  it("answers yes for a file the ledger does not hold", () => {
    expect(shouldProcess(key, [])).toBe(true);
    expect(shouldProcess(key, ["2048:1763000000123:/watched/other.pdf"])).toBe(true);
  });

  it("answers no for a file the ledger holds, which is what a restart reads", () => {
    expect(shouldProcess(key, [key])).toBe(false);
    expect(shouldProcess(key, ["2048:1763000000123:/watched/other.pdf", key])).toBe(false);
  });

  it("answers yes for a file whose size or time has moved, which is the whole point of the key", () => {
    const ledger = [key];
    expect(shouldProcess(fileKey(path, 2048, 1_763_000_000_124), ledger)).toBe(true);
    expect(shouldProcess(fileKey(path, 4096, 1_763_000_000_123), ledger)).toBe(true);
  });
});
