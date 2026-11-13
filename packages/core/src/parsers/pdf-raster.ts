/**
 * Page rasterization for F§5.5's scanned-PDF fallback: one page of a PDF, rendered to a PNG the OCR
 * engine can read.
 *
 * pdfjs draws a page onto a context, and the context a Node process has is `@napi-rs/canvas`'s — the
 * same native canvas the fixtures are generated with. `@napi-rs/canvas` is a second DOM
 * implementation, so its `SKRSContext2D` is not TypeScript's `CanvasRenderingContext2D` and the
 * render call needs one documented bridge at this boundary; pdfjs is asked for `canvas: null` with
 * the context given explicitly, which is the pairing its own `RenderParameters` documents for a
 * caller that must supply the context itself.
 *
 * The bytes are copied before they are handed over: pdfjs transfers the buffer of the data it is
 * given, so a caller's array is unreadable afterwards unless it is copied first (measured on
 * `pdfjs-dist` 6.5.438 — the second `getDocument` over the same array fails with `DataCloneError`).
 */

import { createCanvas } from "@napi-rs/canvas";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

/** The unit a PDF states its own geometry in: 72 points to the inch, so a scale is `dpi / 72`. */
const POINTS_PER_INCH = 72;

/** How this module asks pdfjs for a page: no network fetch, no font faces, and quiet. */
const DOCUMENT_OPTIONS = {
  useWorkerFetch: false,
  disableFontFace: true,
  verbosity: VerbosityLevel.ERRORS,
} as const;

/**
 * Render one page of a PDF to PNG bytes at the requested resolution (F§5.5).
 *
 * `pageNumber` is 1-based, like F§5.1's `Block.page` and pdfjs's own `getPage`. A document is opened
 * for this one page and closed again, because the caller has bytes and a page number rather than a
 * parsed document; the page is cleaned up whether the render succeeds or not.
 */
export async function rasterizePdfPage(bytes: Uint8Array, pageNumber: number, dpi: number): Promise<Uint8Array> {
  const data = new Uint8Array(bytes);
  const task = getDocument({ ...DOCUMENT_OPTIONS, data });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: dpi / POINTS_PER_INCH });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      await page.render({ canvas: null, canvasContext: context, viewport }).promise;
      return new Uint8Array(canvas.toBuffer("image/png"));
    } finally {
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
}
