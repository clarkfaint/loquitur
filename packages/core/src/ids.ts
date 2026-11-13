import { sha256Hex } from "./hash";

const DOC_ID_LENGTH = 32;

/**
 * The document identifier of F§5.2: the first 32 hexadecimal characters of the SHA-256 of the block
 * texts joined by a single newline, encoded as UTF-8.
 */
export function docIdFor(blockTexts: string[]): string {
  return sha256Hex(blockTexts.join("\n")).slice(0, DOC_ID_LENGTH);
}
