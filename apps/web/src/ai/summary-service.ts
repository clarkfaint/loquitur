/**
 * The web app's summaries (F§9, F§10.1): asking the hub for one, turning a finished one into a document, and
 * reading that document aloud.
 *
 * F§9's summarization runs on the hub — the prompts, the map-reduce, the retries and the cached row are all
 * there — so this module is the page's three doors into it and nothing else:
 *
 * - **`generate`** asks for a summary and, when this device holds the document's model, sends it along. F§7.2
 *   stores an inline document as that document's model, which is exactly what makes a summary work on a device
 *   that has never synced: the reader imported the document here, and the hub has never seen it. A model this
 *   device does not hold is left to the hub's own copy, and the hub answers `MODEL_MISSING` when it has none
 *   either.
 * - **`summaryDocument`** is F§9's "listen to the summary": the summary and its takeaways become an ordinary
 *   `DocumentModel` — `source.kind` `summary`, a heading, the summary, and one list item per takeaway — built by
 *   the same `buildDocument` every parser's output goes through. Nothing about the player changes for it: it is
 *   a document, so it is read, highlighted and remembered like any other.
 * - **`listen`** puts that document in the library, in a folder of its own, and opens it with F§10.1's
 *   `?autoplay=1` so it starts reading itself.
 *
 * A document's identity is F§5.2's hash of its block texts, so the same summary produces the same `docId` every
 * time: asking to listen twice updates one document rather than filling the library with copies.
 */

import { type AiClient, createAiClient } from "@lectern/api-client";
import type { AnySummaryResult, SummaryMode, SummaryStatus } from "@lectern/api-contract";
import { buildDocument, type DocumentMeta, type DocumentModel, type Folder, type LibraryStore, type RawBlock } from "@lectern/core";
import { navigate } from "../router";
import { getStorage } from "../services";
import { useSettingsStore } from "../settings/settings";

/** The folder F§9's listened-to summaries are filed in, made the first time one is. */
export const SUMMARIES_FOLDER = "Summaries";

/** The heading a summary document opens with when the document it summarizes has no title. */
const UNTITLED = "Summary";

/** The failure a caller sees when it asks for a summary before a connection is saved. */
const NO_CONNECTION = "no hub is configured — save a hub URL and token in #/settings (F§10.1)";

/**
 * `aiClient()` — the AI client for the connection the app holds right now (F§7.2, F§11).
 *
 * The connection is read from the settings rather than handed in, because the composition root hands over a hub
 * client and never a credential: F§11's token belongs to F§10.1's connection form, and this is one of the two
 * places that needs it twice.
 */
export function aiClient(): AiClient {
  const connection = useSettingsStore.getState().connection;
  if (connection.hubUrl === "") throw new Error(NO_CONNECTION);
  return createAiClient({
    baseUrl: connection.hubUrl,
    token: connection.token,
    // The token rides in a header, never in a URL (F§11). The transport is the page's own `fetch`, called as a
    // method of the global object so a browser does not refuse it as an illegal invocation.
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

/**
 * `generate(docId, mode)` — ask the hub for a summary, carrying this device's copy of the document when it holds
 * one (F§7.2). The answer is the job's state: `running` for a job this call started, or the cached result.
 */
export async function generate(docId: string, mode: SummaryMode): Promise<SummaryStatus> {
  const client = aiClient();
  const { store } = await getStorage();
  const document = await store.getDocumentModel(docId);
  return await client.requestSummary(docId, mode, document ?? undefined);
}

/**
 * `summaryDocument(result, title)` — F§9's summary as a document, built the way every document is (F§5.4): a
 * heading that names what was summarized, the summary itself, and one list item per takeaway.
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
 * panel only offers the control once one is.
 */
export async function listen(docId: string, mode: SummaryMode): Promise<void> {
  const status = await aiClient().getSummary(docId, mode);
  if (status.status !== "done" || status.result === undefined) {
    throw new Error(`there is no finished ${mode} summary of ${docId} to read (F§9)`);
  }

  const { store } = await getStorage();
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
  navigate(`/read/${encodeURIComponent(model.docId)}?autoplay=1`);
}
