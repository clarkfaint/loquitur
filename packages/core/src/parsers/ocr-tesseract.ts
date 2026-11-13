/**
 * The hub's OCR engine (F§5.5): tesseract.js 7.0.0 behind the `OcrEngine` interface, with the worker
 * reused across calls and the language data read from the installed package rather than the network.
 *
 * Four things this module has to get right. The traineddata comes from
 * `@tesseract.js-data/eng`: tesseract.js fetches `{langPath}/{lang}.traineddata.gz` when the value
 * looks like a URL and reads it with `fs` when it looks like a path, so `langPath` is resolved to a
 * filesystem path from the module's own location (`import.meta.resolve`) and no request is ever made
 * — which is what F§5.5's forbidden list requires. The cache is opt-in: without a `cacheDir` the
 * worker is told `cacheMethod: "none"`, because tesseract.js otherwise reads and writes
 * `.traineddata` in the process's current directory. The engine's answer is validated with zod before
 * a single line of it is trusted: `blocks` is `any` in tesseract.js's own declarations, and the shape
 * below is the whole of what this adapter reads. And an `errorHandler` is supplied so a rejected job
 * arrives as a rejected promise instead of an exception thrown inside tesseract.js's message
 * listener, where nothing of ours could catch it.
 *
 * One worker serves every call for a language, and a language's worker is created on first use
 * (`createWorker` is async, so a synchronous factory can only memoize the promise). `dispose` ends
 * every worker this engine created; the engine stays usable afterwards, and would create new ones.
 */

import type { Worker as TesseractWorker, WorkerOptions } from "tesseract.js";
import { createWorker, OEM } from "tesseract.js";
import { z } from "zod";
import type { OcrEngine, OcrLine, OcrResult } from "../ocr";

/** The id this adapter reports (F§5.5). */
export const TESSERACT_OCR_ID = "tesseract";

/** The installed language-data package this adapter reads English from (F§5.5's hub adapter). */
const LANGUAGE_DATA_PACKAGE = "@tesseract.js-data/eng";

/** The traineddata directory inside that package, and the one its own manifest points at. */
const LANGUAGE_DATA_DIRECTORY = "4.0.0";

/** The refusal F§5.5's adapter reports when the engine's own answer cannot be read. */
export type OcrEngineErrorCode = "OCR_RESPONSE_INVALID";

/** An OCR failure this module raises: the engine answered something this adapter does not understand. */
export class OcrEngineError extends Error {
  readonly code: OcrEngineErrorCode;

  constructor(code: OcrEngineErrorCode, message: string) {
    super(message);
    this.name = "OcrEngineError";
    this.code = code;
  }
}

/**
 * The part of tesseract.js's answer this adapter reads: each block's paragraphs, each paragraph's
 * lines, with the box and the confidence of every line. Everything else on that object — every
 * symbol, choice, font name and row attribute — is stripped by this schema rather than carried.
 */
const BboxSchema = z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() });

const LineSchema = z.object({ text: z.string(), confidence: z.number(), bbox: BboxSchema });

const ResultSchema = z.object({
  data: z.object({
    blocks: z.array(z.object({ paragraphs: z.array(z.object({ lines: z.array(LineSchema) })) })).nullable(),
  }),
});

/** What this adapter reads of `ResultSchema`'s answer. */
type TesseractResult = z.infer<typeof ResultSchema>;

/** What `createTesseractOcrEngine` accepts besides nothing at all. */
export interface TesseractOcrEngineOptions {
  /** The directory tesseract.js may unpack and keep `.traineddata` in (F§5.5's data directory). */
  cacheDir?: string;
}

/** The hub's engine: the interface every caller sees, plus the one call that ends its worker. */
export interface TesseractOcrEngine extends OcrEngine {
  dispose(): Promise<void>;
}

/**
 * Where the installed traineddata lives, as a filesystem path. `langPath` must be a path rather than
 * a URL for tesseract.js's Node worker to read it with `fs` (it fetches anything that parses as a
 * URL), and resolving the package from this module keeps the path correct wherever the workspace is
 * installed.
 */
function languageDataPath(): string {
  return new URL(LANGUAGE_DATA_DIRECTORY, import.meta.resolve(LANGUAGE_DATA_PACKAGE)).pathname;
}

/** The options one worker is created with: the installed language data, and a cache only when asked. */
function workerOptions(cacheDir: string | undefined): Partial<WorkerOptions> {
  return {
    langPath: languageDataPath(),
    gzip: true,
    cacheMethod: cacheDir === undefined ? "none" : "write",
    // tesseract.js throws a rejected job out of its own message listener when no handler is given,
    // where this module's `await` cannot see it; the promise still rejects with the same message.
    errorHandler: () => undefined,
    ...(cacheDir === undefined ? {} : { cachePath: cacheDir }),
  };
}

/** Every line of every paragraph of every block the engine reported, in the order it reported them. */
function linesOf(result: TesseractResult): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        lines.push({
          text: line.text,
          bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1],
          confidence: line.confidence,
        });
      }
    }
  }
  return lines;
}

/**
 * Create the hub's OCR engine (F§5.5). The worker is created on the first `recognize` for a language
 * and reused by every later call with that language; `dispose` terminates every worker it created.
 */
export function createTesseractOcrEngine(options: TesseractOcrEngineOptions = {}): TesseractOcrEngine {
  const workers = new Map<string, Promise<TesseractWorker>>();

  const workerFor = (lang: string): Promise<TesseractWorker> => {
    const running = workers.get(lang);
    if (running !== undefined) return running;
    const created = createWorker(lang, OEM.LSTM_ONLY, workerOptions(options.cacheDir)).catch((error: unknown) => {
      // A worker that failed to start must not be remembered: the next call has to try again.
      workers.delete(lang);
      throw error;
    });
    workers.set(lang, created);
    return created;
  };

  return {
    id: TESSERACT_OCR_ID,

    async recognize(image: Uint8Array, { lang }: { lang: string }): Promise<OcrResult> {
      const worker = await workerFor(lang);
      const recognized = await worker.recognize(image, {}, { blocks: true });
      const parsed = ResultSchema.safeParse(recognized);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
        throw new OcrEngineError("OCR_RESPONSE_INVALID", `tesseract.js returned a result with no readable lines at ${paths}`);
      }
      return { lines: linesOf(parsed.data) };
    },

    async dispose(): Promise<void> {
      const running = [...workers.values()];
      workers.clear();
      await Promise.all(running.map((worker) => worker.then((instance) => instance.terminate()).catch(() => undefined)));
    },
  };
}
