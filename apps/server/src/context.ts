/**
 * The hub's shared context (F§7.1–F§7.3): the configuration, the engines and the TTS cache. Every route module
 * receives this one object rather than reaching for a global, so the whole hub can be built from a
 * configuration and, in a test, from that configuration plus the pieces the test wants to observe.
 */

import type { OcrEngine } from "@lectern/core";
import { createTesseractOcrEngine } from "@lectern/core/parsers";
import {
  createEngineRegistry,
  createKokoroEngine,
  createMockEngine,
  createPiperEngine,
  type EngineRegistry,
  parseVoiceId,
  type TtsEngine,
  type Voice,
} from "@lectern/core-tts";
import type { LlmProvider } from "./ai/provider";
import type { Config } from "./config";
import { type HubDatabase, openDatabase } from "./db/database";
import { createDocumentFiles, type DocumentFiles } from "./db/document-files";
import { migrate } from "./db/migrations";
import { createRecordsRepo, type RecordsRepo } from "./db/records-repo";
import { HubError } from "./errors";
import { createTtsCache, type HubTtsCache } from "./tts-cache";

/** A voice and the engine that serves it (F§6): what a TTS route needs before it can synthesize anything. */
export interface VoiceTarget {
  engine: TtsEngine;
  voice: Voice;
}

/**
 * The hub's engine set (F§6, F§7.1): F§6's registry for the voice list, plus the two lookups the hub's own
 * routes need — the ids the health probe reports, and the engine behind a voice id.
 */
export interface HubEngines extends EngineRegistry {
  ids(): string[];
  targetFor(voiceId: string): Promise<VoiceTarget>;
}

/** The OCR engine a parse may use (F§5.5), as the hub holds it: asked for when one is needed. */
export type OcrProvider = () => OcrEngine;

/**
 * What a caller may replace when it builds the hub: the engines to observe, the cache to inspect, the OCR
 * engine a parse reads an image with, and F§9's LLM provider.
 */
export interface HubOverrides {
  engines?: HubEngines;
  ttsCache?: HubTtsCache;
  ocr?: OcrProvider;
  llm?: LlmProvider;
}

/** Everything a route module is given (F§7.1–F§7.3). */
export interface HubContext {
  config: Config;
  engines: HubEngines;
  ttsCache: HubTtsCache;
  /** The engine a parse reads an image or a scanned page with, built on the first parse that needs one. */
  ocr: OcrProvider;
  /** F§8.4's database file, open for the life of the app and closed when the app is (F§8.2's storage). */
  db: HubDatabase;
  /** F§8.2's record repository: the pushed ops, the change log and the `rev` a pull pages from. */
  records: RecordsRepo;
  /** F§8.4's document files: each document's model and original, under the data directory. */
  files: DocumentFiles;
  /** F§9's LLM provider, present only when an endpoint and a model are configured and nothing else is. */
  llm?: LlmProvider;
}

/**
 * The hub's OCR engine, built the first time a route asks for one (F§5.5).
 *
 * tesseract.js loads its language data and starts a worker on the first page it reads, so a hub that
 * never parses an image pays for neither; the engine object itself is created once and reused, which
 * is why the accessor holds it rather than rebuilding it per call. Its language data is cached under
 * the data directory F§7.1 configures, where F§5.5 puts it.
 */
function lazyOcrEngine(dataDir: string): OcrProvider {
  let engine: OcrEngine | null = null;
  return () => {
    engine ??= createTesseractOcrEngine({ cacheDir: dataDir });
    return engine;
  };
}

/** The engines F§7.1 enables, in the order its table lists them: only the ones the operator configured. */
export function enabledEngines(config: Config): TtsEngine[] {
  const engines: TtsEngine[] = [];
  const kokoroUrl = config.kokoroUrl;
  if (kokoroUrl !== undefined) engines.push(createKokoroEngine({ baseUrl: kokoroUrl }));
  const piperUrl = config.piperUrl;
  if (piperUrl !== undefined) engines.push(createPiperEngine({ baseUrl: piperUrl }));
  if (config.enableMock) engines.push(createMockEngine());
  return engines;
}

/**
 * `createHubEngines(engines)` — F§6's registry over a set of engines, with the two lookups a hub needs.
 *
 * `targetFor` resolves a voice id in two steps and answers `UNKNOWN_VOICE` (F§7.2) for either: an id that is
 * not an `engine:voice` pair, and an id no enabled engine offers. A failing engine's voices are simply absent
 * from the list — F§6's registry keeps the other engines' voices — so a backend that is down answers
 * `UNKNOWN_VOICE` rather than holding the request open.
 */
export function createHubEngines(engines: readonly TtsEngine[]): HubEngines {
  const registry = createEngineRegistry(engines);

  return {
    ...registry,

    ids: () => engines.map((engine) => engine.id),

    targetFor: async (voiceId: string): Promise<VoiceTarget> => {
      const parts = parseVoiceId(voiceId);
      if (parts === null) throw new HubError("UNKNOWN_VOICE", `${voiceId} is not an engine:voice identifier (F§6)`);
      const engine = engines.find((candidate) => candidate.id === parts.engine);
      if (engine === undefined) throw new HubError("UNKNOWN_VOICE", `this hub has no enabled engine named ${parts.engine}`);
      const voice = (await registry.listVoices()).find((candidate) => candidate.id === voiceId);
      if (voice === undefined) throw new HubError("UNKNOWN_VOICE", `no enabled engine offers the voice ${voiceId}`);
      return { engine, voice };
    },
  };
}

/**
 * `createHubContext(config, overrides)` — the hub's shared context (F§7.1–F§7.3, F§8.2, F§8.4).
 *
 * The engines F§7.1 enables are built from the configuration; the TTS cache is rooted at the configured data
 * directory. Either may be replaced, which is how a test watches what a route asked an engine for without a
 * service of its own.
 *
 * The database is opened and taken to F§8.4's schema here, when the hub is built, rather than on the first
 * request that needs it: a hub whose storage cannot be opened has nothing to serve, so it fails while it is
 * being built. The app closes the connection in its own close hook, and the record repository and the
 * document files are built over the same data directory the rest of the hub uses.
 *
 * F§9's LLM provider is built by the app factory and handed in here, so this module never reads the
 * configuration's own LLM fields and the context carries the provider only when there is one.
 */
export async function createHubContext(config: Config, overrides: HubOverrides = {}): Promise<HubContext> {
  const engines = overrides.engines ?? createHubEngines(enabledEngines(config));
  const ttsCache = overrides.ttsCache ?? createTtsCache(config.dataDir);
  const db = await openDatabase(config.dataDir);
  migrate(db);
  return {
    config,
    engines,
    ttsCache,
    ocr: overrides.ocr ?? lazyOcrEngine(config.dataDir),
    db,
    records: createRecordsRepo(db),
    files: createDocumentFiles(config.dataDir),
    ...(overrides.llm === undefined ? {} : { llm: overrides.llm }),
  };
}
