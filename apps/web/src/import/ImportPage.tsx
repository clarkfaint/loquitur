/**
 * The import screen (F§10.1): `#/import`, and `#/import?url=…` when the reading extension hands a page over
 * (F§10.2). Four ways in — a drop zone, a file picker, a link, and pasted text — all of which end at the
 * same place: the hub reads the document (F§7.2), and what comes back is what the library keeps.
 *
 * Every import the reader starts is one row of the list below the forms, with its own outcome, because two
 * files dropped together are two documents and one of them can fail while the other is kept. A row says
 * which document it was, whether it was added or already held, and — when the hub refused — the code and the
 * words the hub sent, which is the only useful thing to show about a refusal (F§7.2).
 *
 * The screen's own rules are injected as a `<style>` element rather than added to `app.css`, whose owner
 * (the shell's unit) is frozen: the sheet is part of that unit's delivery, and a screen that needs a rule for
 * its own layout adds it here, in the tokens `@lectern/ui-web/styles.css` already declares.
 */

import { HubClientError } from "@lectern/api-client";
import { type ChangeEvent, type DragEvent, type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useHashRoute } from "../router";
import { type ImportResult, importFile, importText, importUrl } from "./import-service";

/** What one import is doing, as its row shows it. */
type ImportStatus = "importing" | "done" | "duplicate" | "error";

/** One import the reader started: what it was, and how it ended. */
interface ImportItem {
  key: number;
  label: string;
  status: ImportStatus;
  docId?: string;
  message?: string;
}

/** The file types the picker offers, which are the formats F§5.4 reads (F§10.1). */
const ACCEPT = ".pdf,.epub,.docx,.txt,.md,.html,.png,.jpg,.jpeg,.webp";

/** The ids the labels point at, so every field is reachable by its name. */
const FILE_INPUT_ID = "lectern-import-file";
const URL_INPUT_ID = "lectern-import-url";
const TITLE_INPUT_ID = "lectern-import-title";
const TEXT_INPUT_ID = "lectern-import-text";

/** The id of the `<style>` element this screen's rules live in. */
const STYLE_ID = "lectern-import-styles";

/** The screen's layout, in the design tokens the stylesheet declares. */
const RULES = [
  ".lectern-import { display: flex; flex-direction: column; gap: var(--lectern-space-5); }",
  ".lectern-import__intro { color: var(--lectern-ink-muted); margin: 0; max-width: 42rem; }",
  ".lectern-import__section { background: var(--lectern-surface); border: 1px solid var(--lectern-line);",
  "  border-radius: var(--lectern-radius-3); padding: var(--lectern-space-4); }",
  ".lectern-import__section h2 { font-size: 1rem; margin: 0 0 var(--lectern-space-3); }",
  ".lectern-import__drop { border: 1px dashed var(--lectern-line); border-radius: var(--lectern-radius-2);",
  "  display: flex; flex-direction: column; gap: var(--lectern-space-3); padding: var(--lectern-space-4); }",
  ".lectern-import__drop-hint { color: var(--lectern-ink-muted); margin: 0; }",
  ".lectern-import__field { display: flex; flex-direction: column; gap: var(--lectern-space-1);",
  "  margin-block-end: var(--lectern-space-3); }",
  ".lectern-import__field label { color: var(--lectern-ink-muted); font-size: 0.875rem; }",
  ".lectern-import__field input, .lectern-import__field textarea { background: var(--lectern-paper);",
  "  border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-2); color: var(--lectern-ink);",
  "  font: inherit; padding: var(--lectern-space-2); }",
  ".lectern-import__field textarea { min-height: 8rem; resize: vertical; }",
  ".lectern-import button { background: var(--lectern-accent); border: 1px solid var(--lectern-accent);",
  "  border-radius: var(--lectern-radius-2); color: var(--lectern-accent-ink); cursor: pointer; font: inherit;",
  "  padding: var(--lectern-space-2) var(--lectern-space-4); }",
  ".lectern-import__items { display: flex; flex-direction: column; gap: var(--lectern-space-2);",
  "  list-style: none; margin: 0; padding: 0; }",
  ".lectern-import__item { align-items: baseline; background: var(--lectern-surface);",
  "  border: 1px solid var(--lectern-line); border-radius: var(--lectern-radius-2); display: flex;",
  "  gap: var(--lectern-space-3); justify-content: space-between; padding: var(--lectern-space-2) var(--lectern-space-3); }",
  '.lectern-import__item[data-status="error"] .lectern-import__item-state { color: var(--lectern-danger); }',
  '.lectern-import__item[data-status="done"] .lectern-import__item-state { color: var(--lectern-accent); }',
  ".lectern-import__item-state { color: var(--lectern-ink-muted); }",
  ".lectern-import__empty { color: var(--lectern-ink-muted); }",
].join("\n");

/** A counter behind the rows' React keys, so two imports of one document are still two rows. */
let rowCounter = 0;

/** The key of the next row. */
function nextKey(): number {
  rowCounter += 1;
  return rowCounter;
}

/** What a row says about its outcome. */
function outcomeOf(item: ImportItem): string {
  switch (item.status) {
    case "importing":
      return "Reading it…";
    case "done":
      return "Added to the library";
    case "duplicate":
      return "Already in the library — nothing was added";
    case "error":
      return item.message ?? "The import failed";
  }
}

/** What to show about a failure: the hub's own code and words when the hub answered (F§7.2). */
function describeFailure(cause: unknown): string {
  if (cause instanceof HubClientError) return `${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

export function ImportPage(): ReactElement {
  const route = useHashRoute();
  const linkedUrl = route.query.get("url") ?? "";
  const [urlDraft, setUrlDraft] = useState(linkedUrl);
  const [titleDraft, setTitleDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [items, setItems] = useState<ImportItem[]>([]);
  const autoStarted = useRef(false);

  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = RULES;
    document.head.append(style);
  }, []);

  /**
   * Run one import and keep its row up to date. The row is added before the work starts, so a document that
   * takes a while to read is visible while it is being read, and every outcome — added, already held,
   * refused — lands in the same row.
   */
  const runImport = useCallback(async (label: string, read: () => Promise<ImportResult>): Promise<void> => {
    const key = nextKey();
    const settle = (patch: Partial<ImportItem>): void =>
      setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
    setItems((current) => [...current, { key, label, status: "importing" }]);
    try {
      const result = await read();
      settle(result.duplicate ? { status: "duplicate", docId: result.docId } : { status: "done", docId: result.docId });
    } catch (cause) {
      settle({ status: "error", message: describeFailure(cause) });
    }
  }, []);

  // A link that arrives with the route is the one thing this screen starts by itself (F§10.2), and it starts
  // once: the query stays in the address bar, so a second effect run would import the page twice.
  useEffect(() => {
    if (linkedUrl === "" || autoStarted.current) return;
    autoStarted.current = true;
    void runImport(linkedUrl, () => importUrl(linkedUrl));
  }, [linkedUrl, runImport]);

  const startFiles = (files: FileList): void => {
    for (const file of files) void runImport(file.name, () => importFile(file));
  };

  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files === null) return;
    startFiles(event.target.files);
    // The same file chosen twice in a row is still a second choice, which a browser does not report on its
    // own once the input holds a value: clearing it here is what makes the second pick an event.
    event.target.value = "";
  };

  const allowDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (event.dataTransfer.files.length > 0) startFiles(event.dataTransfer.files);
  };

  const submitUrl = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const url = urlDraft.trim();
    if (url === "") return;
    void runImport(url, () => importUrl(url));
  };

  const submitText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (textDraft.trim() === "") return;
    const title = titleDraft.trim();
    void runImport(title === "" ? "Pasted text" : title, () => (title === "" ? importText(textDraft) : importText(textDraft, title)));
  };

  return (
    <main className="lectern-import">
      <h1>Import</h1>
      <p className="lectern-import__intro">
        Your hub reads the document and this device keeps it. A file, a link, or text you paste — all of them arrive the same way, and a
        document you have imported before is never added twice.
      </p>

      <section className="lectern-import__section" aria-labelledby="lectern-import-files-heading">
        <h2 id="lectern-import-files-heading">From a file</h2>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop zone is a shortcut for the file picker beside it, which is the keyboard path; the zone itself holds no control to focus. */}
        <div className="lectern-import__drop" onDragOver={allowDrop} onDrop={onDrop}>
          <p className="lectern-import__drop-hint">Drop files here, or choose them below.</p>
          <div className="lectern-import__field">
            <label htmlFor={FILE_INPUT_ID}>Files</label>
            <input id={FILE_INPUT_ID} type="file" multiple accept={ACCEPT} onChange={onFilesChosen} />
          </div>
        </div>
      </section>

      <section className="lectern-import__section" aria-labelledby="lectern-import-link-heading">
        <h2 id="lectern-import-link-heading">From a link</h2>
        <form onSubmit={submitUrl}>
          <div className="lectern-import__field">
            <label htmlFor={URL_INPUT_ID}>URL</label>
            <input
              id={URL_INPUT_ID}
              name="url"
              type="url"
              autoComplete="off"
              placeholder="https://example.org/an-article"
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
            />
          </div>
          <button type="submit">Import link</button>
        </form>
      </section>

      <section className="lectern-import__section" aria-labelledby="lectern-import-text-heading">
        <h2 id="lectern-import-text-heading">From a paste</h2>
        <form onSubmit={submitText}>
          <div className="lectern-import__field">
            <label htmlFor={TITLE_INPUT_ID}>Title</label>
            <input
              id={TITLE_INPUT_ID}
              name="title"
              type="text"
              autoComplete="off"
              placeholder="What to call it in the library"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </div>
          <div className="lectern-import__field">
            <label htmlFor={TEXT_INPUT_ID}>Text</label>
            <textarea id={TEXT_INPUT_ID} name="text" value={textDraft} onChange={(event) => setTextDraft(event.target.value)} />
          </div>
          <button type="submit">Import text</button>
        </form>
      </section>

      <section className="lectern-import__section" aria-labelledby="lectern-import-progress-heading">
        <h2 id="lectern-import-progress-heading">Imports</h2>
        {items.length === 0 ? (
          <p className="lectern-import__empty" role="status">
            Nothing imported yet.
          </p>
        ) : (
          <ul className="lectern-import__items">
            {items.map((item) => (
              <li key={item.key} className="lectern-import__item" data-import-item="true" data-status={item.status}>
                <span className="lectern-import__item-label">{item.label}</span>
                <span className="lectern-import__item-state">{outcomeOf(item)}</span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="#/library">Go to the library</a>
        </p>
      </section>
    </main>
  );
}
