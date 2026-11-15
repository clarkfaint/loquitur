/**
 * The Android app's Node-side tests (AGENTS.md §7).
 *
 * Two of this package's modules can run without a device: `src/selftest.ts`, which is the golden-value check
 * the app also runs on the device, and the connection boundary in `src/connection.ts`, which is where a deep
 * link or a text field becomes a validated hub address and a token in the platform's secure store. The native
 * modules those two modules stand on are replaced with their own doubles here, so what runs is the real
 * validation, the real store round trip and the real F§7.2 client — the parts a device would otherwise be the
 * first ever to run.
 *
 * A screen under `app/` needs a renderer and a device service in reach, so it is exercised by the on-device
 * diagnostics screen this unit ships (U-052) rather than here.
 */

import { docIdFor } from "@lectern/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOC_ID_ONE_BLOCK, DOC_ID_TWO_BLOCKS, runCoreSelfTest } from "../selftest";

/** A stand-in for the platform's secure store: an in-memory map behind the three methods the app calls. */
const secureStore = vi.hoisted(() => {
  const items = new Map<string, string>();
  return {
    items,
    getItemAsync: vi.fn(async (key: string) => items.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      items.delete(key);
    }),
  };
});

/** A stand-in for `expo/fetch`: it records what was asked and answers from a queue the test fills. */
const hub = vi.hoisted(() => {
  const requests: { url: string; method: string; authorization: string | undefined }[] = [];
  const answers: { status: number; payload: unknown }[] = [];
  return {
    requests,
    answers,
    fetch: vi.fn(async (input: URL, init?: { method?: string; headers?: Record<string, string> }) => {
      requests.push({ url: input.href, method: init?.method ?? "GET", authorization: init?.headers?.authorization });
      const answer = answers.shift() ?? { status: 200, payload: undefined };
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.payload };
    }),
  };
});

vi.mock("expo-secure-store", () => secureStore);
vi.mock("expo/fetch", () => ({ fetch: hub.fetch }));

/** One voice, in F§6's shape, so a voice list validates. */
const MOCK_VOICE = { id: "mock:mock-a", engine: "mock", engineVoiceId: "mock-a", name: "Mock A", lang: "en-US" };

/** A fresh connection module: its cache, its loaded flag and its listeners start empty in every case. */
async function freshConnection() {
  vi.resetModules();
  return import("../connection");
}

/** The diagnostics registry, imported after `freshConnection()` so it shares that module instance. */
async function freshChecks() {
  const { checks } = await import("../diagnostics/checks");
  return checks;
}

beforeEach(() => {
  secureStore.items.clear();
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockClear();
  hub.requests.length = 0;
  hub.answers.length = 0;
  hub.fetch.mockClear();
});

describe("the core self-test", () => {
  it("reports every case ok on this engine", () => {
    const failed = runCoreSelfTest()
      .filter((testCase) => !testCase.ok)
      .map((testCase) => testCase.name);
    expect(failed).toEqual([]);
  });

  it("covers F§5.2, the six F§5.3 tokenizer cases, F§5.6(a), (c) and (e)", () => {
    const names = runCoreSelfTest().map((testCase) => testCase.name);
    expect(names).toHaveLength(18);
    for (const expected of [
      "F§5.2 docId of one block",
      "F§5.2 docId of two blocks",
      "F§5.3 punctuation runs",
      "F§5.3 initials",
      "F§5.3 exact-case abbreviation set",
      "F§5.6(a) estimated timings",
      "F§5.6(c) active word past the end",
      "F§5.6(e) plan (5.0, 1)",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("pins the docId constants to features.md's goldens", () => {
    expect(DOC_ID_ONE_BLOCK).toBe("f8c3bf62a9aa3e6fc1619c250e48abe7");
    expect(DOC_ID_TWO_BLOCKS).toBe("684c0459dd47803dec1ee32224195049");
    expect(docIdFor(["Hello, world."])).toBe(DOC_ID_ONE_BLOCK);
    expect(docIdFor(["Title", "Hello, world. Second sentence here."])).toBe(DOC_ID_TWO_BLOCKS);
  });
});

describe("normalizeHubUrl", () => {
  it("keeps the origin and drops a trailing slash, whitespace and a path's own slash", async () => {
    const { normalizeHubUrl } = await freshConnection();
    expect(normalizeHubUrl("  http://hub.local:8787/  ")).toBe("http://hub.local:8787");
    expect(normalizeHubUrl("https://hub.example/lectern/")).toBe("https://hub.example/lectern");
  });

  it("refuses anything that is not an http(s) origin", async () => {
    const { normalizeHubUrl } = await freshConnection();
    expect(normalizeHubUrl("hub.local:8787")).toBeNull();
    expect(normalizeHubUrl("ftp://hub.local")).toBeNull();
    expect(normalizeHubUrl("")).toBeNull();
  });

  it("refuses a query or a fragment, which no hub route starts from", async () => {
    const { normalizeHubUrl } = await freshConnection();
    expect(normalizeHubUrl("http://hub.local:8787/?token=x")).toBeNull();
    expect(normalizeHubUrl("http://hub.local:8787/#/settings")).toBeNull();
  });
});

describe("the connection store", () => {
  it("saves both values, normalized, and hands them back", async () => {
    const { getConnection, setConnection, HUB_URL_KEY, TOKEN_KEY } = await freshConnection();
    expect(await getConnection()).toBeNull();

    await setConnection({ hubUrl: "http://hub.local:8787/", token: "  s3cret-token  " });

    expect(secureStore.items.get(HUB_URL_KEY)).toBe("http://hub.local:8787");
    expect(secureStore.items.get(TOKEN_KEY)).toBe("s3cret-token");
    expect(await getConnection()).toEqual({ hubUrl: "http://hub.local:8787", token: "s3cret-token" });
  });

  it("reads a half-written record as no hub at all", async () => {
    secureStore.items.set("lectern.hub-url", "http://hub.local:8787");
    const { getConnection } = await freshConnection();
    expect(await getConnection()).toBeNull();
  });

  it("refuses an address it cannot reach, and writes nothing", async () => {
    const { setConnection } = await freshConnection();
    await expect(setConnection({ hubUrl: "not-a-url", token: "s3cret-token" })).rejects.toThrow(/http\(s\) URL/);
    await expect(setConnection({ hubUrl: "http://hub.local:8787", token: "   " })).rejects.toThrow(/token/);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("tells every listener, and stops telling one that has unsubscribed", async () => {
    const { onConnectionChanged, setConnection } = await freshConnection();
    const heard: string[] = [];
    const unsubscribe = onConnectionChanged((connection) => heard.push(connection?.hubUrl ?? "none"));
    await setConnection({ hubUrl: "http://hub.local:8787", token: "s3cret-token" });
    unsubscribe();
    await setConnection({ hubUrl: "http://other.local", token: "s3cret-token" });
    expect(heard).toEqual(["http://hub.local:8787"]);
  });
});

describe("createClient", () => {
  it("refuses while no hub is configured", async () => {
    const { createClient } = await freshConnection();
    await expect(createClient()).rejects.toThrow(/not configured yet/);
    expect(hub.fetch).not.toHaveBeenCalled();
  });

  it("asks the hub with F§11's bearer token in a header, never in the URL", async () => {
    const { createClient, setConnection } = await freshConnection();
    await setConnection({ hubUrl: "http://hub.local:8787", token: "s3cret-token" });
    hub.answers.push({ status: 200, payload: { ok: true, version: "0.0.0", engines: ["mock"] } });

    const client = await createClient();
    await expect(client.health()).resolves.toEqual({ ok: true, version: "0.0.0", engines: ["mock"] });

    expect(hub.requests).toEqual([{ url: "http://hub.local:8787/healthz", method: "GET", authorization: "Bearer s3cret-token" }]);
  });

  it("reports a hub's refusal as its own code", async () => {
    const { createClient, setConnection } = await freshConnection();
    await setConnection({ hubUrl: "http://hub.local:8787", token: "wrong-token" });
    hub.answers.push({ status: 401, payload: { error: { code: "UNAUTHORIZED", message: "the token is not the hub's" } } });

    const client = await createClient();
    await expect(client.voices()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("reports an unreachable hub as offline rather than as a refusal", async () => {
    const { createClient, setConnection } = await freshConnection();
    await setConnection({ hubUrl: "http://hub.local:8787", token: "s3cret-token" });
    hub.fetch.mockRejectedValueOnce(new Error("Network request failed"));

    const client = await createClient();
    await expect(client.health()).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE", offline: true, status: 0 });
  });
});

describe("the diagnostics registry", () => {
  it("registers this unit's two checks in order", async () => {
    await freshConnection();
    const checks = await freshChecks();
    expect(checks.map((check) => check.id)).toEqual(expect.arrayContaining(["core-selftest", "hub-health"]));
  });

  it("passes the core check on this engine", async () => {
    await freshConnection();
    const checks = await freshChecks();
    const result = await checks[0].run();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("goldens");
  });

  it("says no hub is configured when none is saved", async () => {
    await freshConnection();
    const checks = await freshChecks();
    const result = await checks[1].run();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no hub is configured yet");
  });

  it("reports the hub's version, engines and voices when one is saved", async () => {
    const { setConnection } = await freshConnection();
    await setConnection({ hubUrl: "http://hub.local:8787", token: "s3cret-token" });
    const checks = await freshChecks();
    hub.answers.push({ status: 200, payload: { ok: true, version: "0.0.0", engines: ["mock"] } });
    hub.answers.push({ status: 200, payload: [MOCK_VOICE] });

    const result = await checks[1].run();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("version 0.0.0");
    expect(result.detail).toContain("1 voices");
    expect(hub.requests.map((request) => request.url)).toEqual(["http://hub.local:8787/healthz", "http://hub.local:8787/v1/voices"]);
  });

  it("reports a hub that is not answering as the failure it is", async () => {
    const { setConnection } = await freshConnection();
    await setConnection({ hubUrl: "http://hub.local:8787", token: "s3cret-token" });
    const checks = await freshChecks();
    hub.fetch.mockRejectedValueOnce(new Error("Network request failed"));

    const result = await checks[1].run();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not be reached");
  });
});
