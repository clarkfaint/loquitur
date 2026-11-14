/**
 * Chunk identity (F§6): a synthesized chunk is named by everything that decides its audio, so the hub can
 * cache it, a client can predict it before the bytes arrive, and two devices that ask for the same text at
 * the same engine speed share one file.
 */

import { sha256Hex } from "@lectern/core";

/** The field separator of F§6's hashed tuple. */
const FIELD_SEPARATOR = "\u0000";

/** How much of the digest a chunk id keeps (F§6). */
const CHUNK_ID_LENGTH = 40;

/**
 * `chunkIdFor(engine, engineVoiceId, synthSpeed, text)` — F§6's formula, verbatim:
 * `sha256Hex([engine, engineVoiceId, synthSpeed.toFixed(2), text].join('\u0000')).slice(0, 40)`.
 *
 * The speed is written with two decimals, so `1`, `1.0` and `1.00` are one chunk, and the two golden
 * values in F§6 are the fixed points this function is held to. The digest is `@lectern/core`'s own
 * pure-TypeScript SHA-256, so the browser, the extension and the hub agree on a chunk id without a
 * crypto module.
 */
export function chunkIdFor(engine: string, engineVoiceId: string, synthSpeed: number, text: string): string {
  const fields = [engine, engineVoiceId, synthSpeed.toFixed(2), text];
  return sha256Hex(fields.join(FIELD_SEPARATOR)).slice(0, CHUNK_ID_LENGTH);
}
