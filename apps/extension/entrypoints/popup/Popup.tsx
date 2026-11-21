/**
 * The popup (F§10.2): the connection form, and the two actions that start a reading.
 *
 * The form edits the extension's own settings record and, on save, does the two things F§10.2 asks for in
 * order: it requests the hub origin as a host permission — the origin is optional precisely so that this is a
 * visible, deliberate grant rather than something installed up front (F§11) — and then it proves the
 * connection by asking the hub. F§7.2 leaves `/healthz` unauthenticated, so the probe is followed by the
 * voice list: a token the hub refuses is reported as a refusal instead of reading as a working connection.
 *
 * The two buttons send protocol messages and show whatever the service worker answers, so a refusal is the
 * reader's to see rather than a silently dead button.
 */

import { createHubClient, HubClientError } from "@lectern/api-client";
import { RATE_MAX, RATE_MIN, RATE_STEP } from "@lectern/core";
import type { Voice } from "@lectern/core-tts";
import { formatRate } from "@lectern/ui-web";
import { type FormEvent, useEffect, useState } from "react";
import { type ExtMessage, ExtStatusSchema, sendMessage } from "../../src/messages";
import { DEFAULT_EXT_SETTINGS, type ExtSettings, getSettings, isHttpUrl, originPattern, setSettings } from "../../src/settings";

/** What a save found out: the sentence to show, and the voices the hub knows. */
interface ConnectionReport {
  notice: string;
  voices: Voice[];
}

/**
 * Ask the service worker what the extension is connected to. The popup does not answer this from the stored
 * record alone: the worker is the context that owns the session, so its answer is the one the reader sees.
 */
async function readStatus(): Promise<string> {
  const reply = await sendMessage({ type: "ext/get-status" });
  if (!reply.ok) return `The extension did not answer — ${reply.code}: ${reply.message}`;
  const status = ExtStatusSchema.safeParse(reply.data);
  if (!status.success) return "The extension answered a status this popup cannot read";
  return status.data.connected
    ? `Connected to ${status.data.hubUrl}.`
    : "No hub is connected yet — fill in the hub URL and token, then save.";
}

/** Reach the hub with the settings just saved, and report what it answered in the reader's words. */
async function testHub(settings: ExtSettings): Promise<ConnectionReport> {
  if (!isHttpUrl(settings.hubUrl) || settings.token === "") {
    return { notice: "Saved. A hub URL and token are both needed to test the connection.", voices: [] };
  }
  // Wrapped, as the offscreen document does: the client calls `options.fetch(...)`, and a browser's `fetch` invoked
  // with any receiver but the global object throws "Illegal invocation".
  const client = createHubClient({
    baseUrl: settings.hubUrl,
    token: settings.token,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  try {
    await client.health();
    const voices = await client.voices();
    return { notice: `Connected to ${settings.hubUrl} — ${voices.length} voices available.`, voices };
  } catch (cause) {
    if (cause instanceof HubClientError) {
      const where = cause.offline ? "could not be reached" : "refused the request";
      return { notice: `The hub ${where} — ${cause.code}: ${cause.message}`, voices: [] };
    }
    return { notice: `The hub could not be reached — ${cause instanceof Error ? cause.message : String(cause)}`, voices: [] };
  }
}

/** The popup. */
export function Popup() {
  const [settings, setLocalSettings] = useState<ExtSettings>(DEFAULT_EXT_SETTINGS);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [notice, setNotice] = useState("Reading the extension's settings…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getSettings();
      const status = await readStatus();
      if (cancelled) return;
      setLocalSettings(stored);
      setNotice(status);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** One editable field, applied to the form's copy of the settings. */
  function edit(patch: Partial<ExtSettings>): void {
    setLocalSettings((current) => ({ ...current, ...patch }));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      if (settings.hubUrl !== "" && !isHttpUrl(settings.hubUrl)) {
        setNotice("The hub URL must be an absolute http or https address.");
        return;
      }
      const pattern = settings.hubUrl === "" ? null : originPattern(settings.hubUrl);
      if (pattern !== null && !(await chrome.permissions.request({ origins: [pattern] }))) {
        setNotice(`${pattern} was not granted, so the hub cannot be reached.`);
        return;
      }
      const saved = await setSettings(settings);
      setLocalSettings(saved);
      const report = await testHub(saved);
      setVoices(report.voices);
      setNotice(report.notice);
    } finally {
      setBusy(false);
    }
  }

  async function act(message: ExtMessage, done: string): Promise<void> {
    setBusy(true);
    try {
      const reply = await sendMessage(message);
      setNotice(reply.ok ? done : `Refused — ${reply.code}: ${reply.message}`);
    } finally {
      setBusy(false);
    }
  }

  const voiceOptions =
    settings.voiceId !== "" && !voices.some((voice) => voice.id === settings.voiceId)
      ? [...voices, { id: settings.voiceId, name: settings.voiceId, lang: "", engine: "", engineVoiceId: "" }]
      : voices;

  return (
    <form onSubmit={(event) => void save(event)}>
      <label htmlFor="hub-url">
        Hub URL
        <input
          id="hub-url"
          type="text"
          autoComplete="off"
          placeholder="http://127.0.0.1:8787"
          value={settings.hubUrl}
          onChange={(event) => edit({ hubUrl: event.currentTarget.value })}
        />
      </label>

      <label htmlFor="hub-token">
        Token
        <input
          id="hub-token"
          type="password"
          autoComplete="off"
          value={settings.token}
          onChange={(event) => edit({ token: event.currentTarget.value })}
        />
      </label>

      <label htmlFor="web-app-url">
        Web app URL
        <input
          id="web-app-url"
          type="text"
          autoComplete="off"
          placeholder="where a PDF is handed to"
          value={settings.webAppUrl}
          onChange={(event) => edit({ webAppUrl: event.currentTarget.value })}
        />
      </label>

      <label htmlFor="voice">
        Voice
        <select id="voice" value={settings.voiceId} onChange={(event) => edit({ voiceId: event.currentTarget.value })}>
          <option value="">The hub chooses</option>
          {voiceOptions.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="rate">
        Speed — {formatRate(settings.rate)}
        <input
          id="rate"
          type="range"
          min={RATE_MIN}
          max={RATE_MAX}
          step={RATE_STEP}
          value={settings.rate}
          onChange={(event) => edit({ rate: Number(event.currentTarget.value) })}
        />
      </label>

      <div className="row">
        <label htmlFor="auto-show">
          <input
            id="auto-show"
            type="checkbox"
            checked={settings.autoShowWidget}
            onChange={(event) => edit({ autoShowWidget: event.currentTarget.checked })}
          />
          Show the widget on its own
        </label>
        <label htmlFor="skip-furniture">
          <input
            id="skip-furniture"
            type="checkbox"
            checked={settings.skipFurniture}
            onChange={(event) => edit({ skipFurniture: event.currentTarget.checked })}
          />
          Skip headers and footers
        </label>
      </div>

      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          Save and test
        </button>
        <button type="button" disabled={busy} onClick={() => void act({ type: "ext/read-active-tab" }, "Reading the page in this tab.")}>
          Read this page
        </button>
      </div>

      <div className="row">
        <button type="button" disabled={busy} onClick={() => void act({ type: "ext/open-pdf" }, "The PDF was handed to the web app.")}>
          Open this PDF in Loquitur
        </button>
      </div>

      <p className="status" role="status">
        {notice}
      </p>
    </form>
  );
}
