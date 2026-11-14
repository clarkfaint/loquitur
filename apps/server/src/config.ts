/**
 * The hub's configuration (F§7.1): every value the hub reads from its environment, the defaults the table
 * names, and a refusal for anything that would otherwise leave the hub running on a guess.
 *
 * `loadConfig` takes the environment as an argument instead of reading a host global, so one function serves
 * the entry point, a test and any embedder, and nothing in this module inspects the process it runs in.
 */

import { z } from "zod";
import { describeIssues } from "./errors";

/** The version the health probe reports (F§7.2). It sits beside the configuration because it is the hub's own identity. */
export const HUB_VERSION = "0.0.0";

/** F§7.1's floor for the single pre-shared token, and F§11's whole authentication story. */
const MIN_TOKEN_LENGTH = 32;

/** F§7.1's defaults: the listening port, the data directory and the upload limit. */
const DEFAULT_PORT = 8787;
const DEFAULT_DATA_DIR = "./data";
const DEFAULT_MAX_UPLOAD_MB = 100;

/** The environment a hub reads: a plain record of names to values, which is exactly what a process environment is. */
export type HubEnv = Readonly<Record<string, string | undefined>>;

/** A base URL an engine adapter can be built from: an absolute `http` or `https` address with a host. */
const BASE_URL = /^https?:\/\/[^\s/]+/;

const BaseUrlSchema = z
  .string()
  .min(1)
  .refine((value) => BASE_URL.test(value), { error: "must be an absolute http(s) URL" });

/**
 * F§7.1's table as one schema. The token, the port, the data directory and the two limits are always present
 * once `loadConfig` has applied the table's defaults; the two engine URLs and the three LLM fields stay absent
 * when they are unset, which is what switches those features off. The object is strict, so the shape a caller
 * receives is the shape the table describes rather than a bag of strings.
 */
export const ConfigSchema = z.strictObject({
  token: z.string().min(MIN_TOKEN_LENGTH),
  port: z.int().min(1).max(65535),
  dataDir: z.string().min(1),
  kokoroUrl: BaseUrlSchema.exactOptional(),
  piperUrl: BaseUrlSchema.exactOptional(),
  enableMock: z.boolean(),
  llmBaseUrl: BaseUrlSchema.exactOptional(),
  llmModel: z.string().min(1).exactOptional(),
  llmApiKey: z.string().min(1).exactOptional(),
  maxUploadMb: z.int().min(1),
  allowPrivateFetch: z.boolean(),
});
export type Config = z.infer<typeof ConfigSchema>;

/** The five optional variables of F§7.1 and the field each one fills: unset means the feature is off. */
const OPTIONAL_FIELDS = [
  ["kokoroUrl", "KOKORO_URL"],
  ["piperUrl", "PIPER_URL"],
  ["llmBaseUrl", "LLM_BASE_URL"],
  ["llmModel", "LLM_MODEL"],
  ["llmApiKey", "LLM_API_KEY"],
] as const;

/** An environment value that is set, or nothing when it is unset or empty — an empty variable counts as unset. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** F§7.1's `0`/`1` flags: `1` is on, `0` is off, and anything else is refused rather than read as a default. */
function asFlag(name: string, value: string | undefined, fallback: boolean): boolean {
  const set = present(value);
  if (set === undefined) return fallback;
  if (set === "1") return true;
  if (set === "0") return false;
  throw new Error(`${name} must be 0 or 1 (F§7.1), received ${JSON.stringify(set)}`);
}

/** A whole number from the environment, so a mistyped port fails here rather than becoming a listening socket. */
function asInteger(name: string, value: string | undefined, fallback: number): number {
  const set = present(value);
  if (set === undefined) return fallback;
  const parsed = Number(set);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be a whole number, received ${JSON.stringify(set)}`);
  return parsed;
}

/**
 * `loadConfig(env)` — F§7.1's table, validated.
 *
 * The token is required and at least 32 characters (F§7.1, F§11); the port, the data directory and the two
 * limits take the table's defaults; the engine URLs and the LLM fields are absent when unset. A value the
 * table does not allow fails here, at the edge, and the message names the variable and what it received.
 */
export function loadConfig(env: HubEnv): Config {
  const token = present(env.LECTERN_TOKEN);
  if (token === undefined) throw new Error("LECTERN_TOKEN is required (F§7.1): the hub has no token to authenticate with");
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`LECTERN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (F§7.1), received ${token.length}`);
  }
  const candidate: Record<string, unknown> = {
    token,
    port: asInteger("LECTERN_PORT", env.LECTERN_PORT, DEFAULT_PORT),
    dataDir: present(env.LECTERN_DATA_DIR) ?? DEFAULT_DATA_DIR,
    enableMock: asFlag("LECTERN_ENABLE_MOCK", env.LECTERN_ENABLE_MOCK, false),
    maxUploadMb: asInteger("LECTERN_MAX_UPLOAD_MB", env.LECTERN_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB),
    allowPrivateFetch: asFlag("LECTERN_ALLOW_PRIVATE_FETCH", env.LECTERN_ALLOW_PRIVATE_FETCH, false),
  };
  for (const [field, name] of OPTIONAL_FIELDS) {
    const value = present(env[name]);
    if (value !== undefined) candidate[field] = value;
  }
  const parsed = ConfigSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`the hub's configuration is invalid — ${describeIssues(parsed.error)}`);
  return parsed.data;
}
