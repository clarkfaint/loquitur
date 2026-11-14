/**
 * The settings screen (F§10.1): the hub connection, the reader's playback preferences, and every section a
 * later unit registers.
 *
 * Two behaviours are worth naming. The connection form keeps its own draft, so a half-typed address is never
 * saved, while "Test connection" checks exactly what is in the form — that is the point of testing before
 * saving. And the saved connection is probed whenever it changes, including on the first render, which is how
 * a reader who reloads the page sees whether the hub still answers and whether the token is still good.
 *
 * F§7.2 exempts the health probe from authentication, so a probe is two calls: `/healthz` proves the hub is
 * there, and `/v1/voices` proves the token. A wrong token that answered only the first would look connected.
 */

import { createHubClient, HubClientError } from "@lectern/api-client";
import { type ChangeEvent, type FormEvent, type ReactElement, useEffect, useState } from "react";
import { sections } from "./sections";
import { type Connection, type Preferences, THEMES, type Theme, useSettingsStore, validateConnection } from "./settings";

/** What the screen is saying about the connection. */
type StatusKind = "idle" | "testing" | "connected" | "error";

interface Status {
  kind: StatusKind;
  message: string;
}

/** The message a first load shows: nothing is saved, and the shell has nowhere else to send the reader. */
const IDLE: Status = { kind: "idle", message: "No hub is configured yet — save a hub URL and token." };

/** The unit the audio-cache limit is shown in; the setting itself is bytes (F§10.1). */
const BYTES_PER_MB = 1024 * 1024;

/** A byte count as the megabytes the form shows. */
function inMegabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/** A megabyte figure as a byte count, with anything unusable reading as "cache nothing". */
function inBytes(megabytes: number): number {
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes) * BYTES_PER_MB : 0;
}

/** What to show a reader when a probe fails: the hub's own code and words when the hub answered (F§7.2). */
function describeFailure(cause: unknown): string {
  if (cause instanceof HubClientError) return `The hub answered ${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The message a working connection shows. It throws F§7.2's refusal instead, which the caller renders.
 */
async function probe(target: Connection): Promise<string> {
  const client = createHubClient({
    baseUrl: target.hubUrl,
    token: target.token,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const health = await client.health();
  const voices = await client.voices();
  const engines = `${health.engines.length} engine${health.engines.length === 1 ? "" : "s"}`;
  const origin = new URL(target.hubUrl).origin;
  return `Connected to ${origin} — hub ${health.version}, ${engines}, ${voices.length} voices`;
}

/** The connection's status paragraph, which the browser tests read by its `data-status`. */
function StatusLine({ status }: { status: Status }): ReactElement {
  return (
    <p className="lectern-settings__status" role="status" data-status={status.kind}>
      {status.message}
    </p>
  );
}

export function SettingsPage(): ReactElement {
  const connection = useSettingsStore((state) => state.connection);
  const preferences = useSettingsStore((state) => state.preferences);
  const update = useSettingsStore((state) => state.update);
  const [draft, setDraft] = useState<Connection>(connection);
  const [status, setStatus] = useState<Status>(() => (connection.hubUrl === "" ? IDLE : { kind: "testing", message: "Checking the hub…" }));

  // The saved connection is the one that matters: it is probed on the first render and again whenever it
  // changes, so saving a connection and reloading the page both end at the same state.
  useEffect(() => {
    if (connection.hubUrl === "") return;
    let live = true;
    const check = async (): Promise<void> => {
      try {
        const message = await probe(connection);
        if (live) setStatus({ kind: "connected", message });
      } catch (cause) {
        if (live) setStatus({ kind: "error", message: describeFailure(cause) });
      }
    };
    void check();
    return () => {
      live = false;
    };
  }, [connection]);

  const checkForm = async (): Promise<void> => {
    const problem = validateConnection(draft);
    if (problem !== null) {
      setStatus({ kind: "error", message: problem });
      return;
    }
    setStatus({ kind: "testing", message: "Checking the hub…" });
    try {
      setStatus({ kind: "connected", message: await probe(draft) });
    } catch (cause) {
      setStatus({ kind: "error", message: describeFailure(cause) });
    }
  };

  const save = async (): Promise<void> => {
    const problem = validateConnection(draft);
    if (problem !== null) {
      setStatus({ kind: "error", message: problem });
      return;
    }
    await update({ connection: draft });
  };

  const onSave = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save();
  };

  const setField =
    (field: keyof Connection) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      setDraft({ ...draft, [field]: event.target.value });
    };

  const setPreference = <K extends keyof Preferences>(field: K, value: Preferences[K]): void => {
    void update({ preferences: { [field]: value } as Partial<Preferences> });
  };

  return (
    <main className="lectern-settings">
      <h1>Settings</h1>

      <section className="lectern-settings__section" aria-labelledby="lectern-connection-heading">
        <h2 id="lectern-connection-heading">Connection</h2>
        <form className="lectern-settings__form" onSubmit={onSave}>
          <div className="lectern-settings__field">
            <label htmlFor="lectern-hub-url">Hub URL</label>
            <input id="lectern-hub-url" name="hubUrl" type="url" autoComplete="off" value={draft.hubUrl} onChange={setField("hubUrl")} />
          </div>
          <div className="lectern-settings__field">
            <label htmlFor="lectern-token">Token</label>
            <input id="lectern-token" name="token" type="password" autoComplete="off" value={draft.token} onChange={setField("token")} />
          </div>
          <div className="lectern-settings__actions">
            <button type="submit">Save</button>
            <button type="button" onClick={() => void checkForm()}>
              Test connection
            </button>
          </div>
        </form>
        <StatusLine status={status} />
      </section>

      <section className="lectern-settings__section" aria-labelledby="lectern-playback-heading">
        <h2 id="lectern-playback-heading">Playback</h2>

        <div className="lectern-settings__field">
          <label htmlFor="lectern-voice">Voice</label>
          <input
            id="lectern-voice"
            name="voiceId"
            type="text"
            autoComplete="off"
            value={preferences.voiceId}
            onChange={(event) => setPreference("voiceId", event.target.value)}
          />
        </div>

        <div className="lectern-settings__field">
          <label htmlFor="lectern-rate">Speed ({preferences.rate}×)</label>
          <input
            id="lectern-rate"
            name="rate"
            type="range"
            min={0.5}
            max={5}
            step={0.1}
            value={preferences.rate}
            onChange={(event) => setPreference("rate", event.target.valueAsNumber)}
          />
        </div>

        <div className="lectern-settings__check">
          <input
            id="lectern-skip-furniture"
            name="skipFurniture"
            type="checkbox"
            checked={preferences.skipFurniture}
            onChange={(event) => setPreference("skipFurniture", event.target.checked)}
          />
          <label htmlFor="lectern-skip-furniture">Skip headers, footers and footnotes</label>
        </div>

        <div className="lectern-settings__check">
          <input
            id="lectern-skip-citations"
            name="skipCitations"
            type="checkbox"
            checked={preferences.skipCitations}
            onChange={(event) => setPreference("skipCitations", event.target.checked)}
          />
          <label htmlFor="lectern-skip-citations">Skip citation markers</label>
        </div>

        <div className="lectern-settings__field">
          <label htmlFor="lectern-lookahead">Highlight lead (ms)</label>
          <input
            id="lectern-lookahead"
            name="lookaheadMs"
            type="number"
            min={0}
            step={10}
            value={preferences.lookaheadMs}
            onChange={(event) => setPreference("lookaheadMs", event.target.valueAsNumber)}
          />
        </div>

        <div className="lectern-settings__field">
          <label htmlFor="lectern-theme">Theme</label>
          <select
            id="lectern-theme"
            name="theme"
            value={preferences.theme}
            onChange={(event) => setPreference("theme", event.target.value as Theme)}
          >
            {THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {theme}
              </option>
            ))}
          </select>
        </div>

        <div className="lectern-settings__field">
          <label htmlFor="lectern-cache-limit">Audio cache limit (MB)</label>
          <input
            id="lectern-cache-limit"
            name="cacheLimitBytes"
            type="number"
            min={0}
            step={16}
            value={inMegabytes(preferences.cacheLimitBytes)}
            onChange={(event) => setPreference("cacheLimitBytes", inBytes(event.target.valueAsNumber))}
          />
        </div>
      </section>

      {sections.map((section) => (
        <section key={section.id} className="lectern-settings__section" aria-labelledby={`lectern-section-${section.id}`}>
          <h2 id={`lectern-section-${section.id}`}>{section.title}</h2>
          <section.component />
        </section>
      ))}
    </main>
  );
}
