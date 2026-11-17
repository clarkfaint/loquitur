/**
 * The Android app's summaries (F§9, F§10.4): asking the hub for one, turning a finished one into a document,
 * and reading that document aloud.
 *
 * F§9's summarization runs on the hub — the prompts, the map-reduce, the retries and the cached row all live
 * there — so this module is the phone's three doors into it, the same three the web app opens (F§10.1):
 *
 * - **`generate`** asks for a summary and, when this device holds the document's model, sends it along. F§7.2
 *   stores an inline document as that document's model, which is exactly what makes a summary work on a phone
 *   that has never synced: the reader imported the document here and the hub has never seen it. A model this
 *   device does not hold is left to the hub's own copy, and the hub answers `MODEL_MISSING` when it has none
 *   either.
 * - **`summaryDocument`** is F§9's "listen to the summary": the summary and its takeaways become an ordinary
 *   `DocumentModel` — `source.kind` `summary`, a heading, the summary and one list item per takeaway — built by
 *   the same `buildDocument` every parser's output goes through. Nothing about the player changes for it: it is
 *   a document, so it is read, highlighted and remembered like any other. This is the unit's pure part, and it
 *   imports nothing from React Native.
 * - **`listen`** files that document in the library's own `Summaries` folder and opens the reader with
 *   F§10.4's `?autoplay=1`, so the summary starts reading itself.
 *
 * A document's identity is F§5.2's hash of its block texts, so the same summary produces the same `docId` every
 * time: asking to listen twice updates one document rather than filling the library with copies.
 *
 * **No platform module is loaded when this module is imported.** The hub connection, the app's stores,
 * `expo/fetch`, `expo-crypto` and expo-router are each reached inside the function that needs them, so the
 * package's own Node test program can import this file and exercise `summaryDocument` without a device — the
 * rule every module of this app follows (U-046, U-047, U-061).
 */

import { type AiClient, createAiClient } from "@lectern/api-client";
import type { AnySummaryResult, SummaryMode, SummaryStatus } from "@lectern/api-contract";
import { buildDocument, type DocumentMeta, type DocumentModel, type Folder, type LibraryStore, type RawBlock } from "@lectern/core";

/** The folder F§9's listened-to summaries are filed in, made the first time one is. */
export const SUMMARIES_FOLDER = "Summaries";

/** The heading a summary document opens with when the document it summarizes has no title. */
const UNTITLED = "Summary";

/** The failure a caller sees when it asks for a summary before a connection is saved. */
const NO_CONNECTION = "no hub is configured — connect from Settings or a lectern://setup link (F§10.4)";

/**
 * `aiClient()` — the AI client for the hub this device holds right now (F§7.2, F§11).
 *
 * The connection is read here rather than handed in, because the app's composition root hands over a hub
 * client and never a credential: F§11's token belongs to the connection screen, and this is one of the two
 * places that needs it twice. The transport is `expo/fetch`, the platform's own HTTP implementation, for the
 * reason U-045 chose it for the hub client — the client is isomorphic and takes its transport as an argument.
 */
export async function aiClient(): Promise<AiClient> {
  const { getConnection } = await import("../connection");
  const connection = await getConnection();
  if (connection === null) throw new Error(NO_CONNECTION);
  const { fetch: expoFetch } = await import("expo/fetch");
  return createAiClient({
    baseUrl: connection.hubUrl,
    token: connection.token,
    // The token rides in a header, never in a URL (F§11).
    fetch: expoFetch as unknown as typeof fetch,
  });
}

/**
 * `generate(docId, mode)` — ask the hub for a summary, carrying this device's copy of the document when it
 * holds one (F§7.2). The answer is the job's state: `running` for a job this call started, or the cached
 * result when F§9's cache key already holds one.
 */
export async function generate(docId: string, mode: SummaryMode): Promise<SummaryStatus> {
  const client = await aiClient();
  const { getStores } = await import("../stores");
  const { store } = await getStores();
  const document = await store.getDocumentModel(docId);
  return await client.requestSummary(docId, mode, document ?? undefined);
}

/**
 * `summaryDocument(result, title)` — F§9's summary as a document, built the way every document is (F§5.4): a
 * heading that names what was summarized, the summary itself, and one list item per takeaway.
 *
 * Pure: F§5.2's identity comes from the block texts, so the same summary is the same document on every device
 * that builds it, and a test can prove the shape without a device.
 */
export function summaryDocument(result: AnySummaryResult, title: string): DocumentModel {
  const named = title.trim();
  const heading = named === "" ? UNTITLED : `Summary of ${named}`;
  const blocks: RawBlock[] = [
    { kind: "heading", level: 1, text: heading },
    { kind: "paragraph", text: result.summary },
    ...result.keyTakeaways.map((takeaway): RawBlock => ({ kind: "list-item", text: takeaway })),
  ];
  return buildDocument(blocks, { title: heading, source: { kind: "summary" } });
}

/** The folder the summaries are filed in: the one that holds them, or a new one at the root of the tree. */
async function summariesFolder(store: LibraryStore): Promise<Folder> {
  const folders = await store.listFolders();
  const held = folders.find((folder) => folder.parentId === null && folder.name === SUMMARIES_FOLDER);
  if (held !== undefined) return held;
  // This installation's identity is `expo-crypto`'s business (U-046's store mints its device id the same way).
  const crypto: typeof import("expo-crypto") = await import("expo-crypto");
  const folder: Folder = {
    id: crypto.randomUUID(),
    name: SUMMARIES_FOLDER,
    parentId: null,
    updatedAt: Date.now(),
    deleted: false,
  };
  await store.putFolder(folder);
  return folder;
}

/**
 * `listen(docId, mode)` — file the finished summary as a document of its own and start reading it.
 *
 * The summary is read back from the hub rather than handed in, so what is read aloud is what the hub holds —
 * the same text a reload of this screen would draw. A summary that is not finished has nothing to read, and the
 * screen only offers the control once one is.
 */
export async function listen(docId: string, mode: SummaryMode): Promise<void> {
  const status = await (await aiClient()).getSummary(docId, mode);
  if (status.status !== "done" || status.result === undefined) {
    throw new Error(`there is no finished ${mode} summary of ${docId} to read (F§9)`);
  }

  const { getStores } = await import("../stores");
  const { store } = await getStores();
  const original = await store.getDocumentMeta(docId);
  const model = summaryDocument(status.result, original?.title ?? "");
  const folder = await summariesFolder(store);
  const now = Date.now();
  const meta: DocumentMeta = {
    docId: model.docId,
    title: model.title,
    sourceKind: "summary",
    folderId: folder.id,
    addedAt: now,
    wordCount: model.wordCount,
    sentenceCount: model.sentenceCount,
    updatedAt: now,
    deleted: false,
  };
  await store.putDocument(meta, model);

  // The reader opens on the summary with F§10.1's own flag, which is the hand-off the web app's summary panel
  // performs as well: the same document, the same route, the same autoplay.
  const { router } = await import("expo-router");
  router.push(`/read/${encodeURIComponent(model.docId)}?autoplay=1`);
}
