import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { sha256Hex } from "../hash";

/**
 * The independent oracle the contract names for this file. The delivered implementation is pure
 * TypeScript, synchronous and free of any crypto import; this test compares it against Node's own
 * SHA-256 so that the assertions are a check on the implementation rather than a restatement of it.
 */
function oracle(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

test("hashes the empty string to the F§5.2 golden value", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("hashes 'abc' to the F§5.2 golden value", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hashes a 1 000-character multi-byte string to the value computed here with node:crypto", () => {
  const thousand = "\u00e9".repeat(250) + "\u6f22".repeat(300) + "\ud83d\ude42".repeat(225);
  expect(thousand.length).toBe(1000);
  expect(sha256Hex(thousand)).toBe(oracle(thousand));
  expect(sha256Hex(thousand)).toBe("23e8223a530a44aca1bd037b90322c50e5b6bf5552c0afde87fb64f849c7ddb0");
});

test("matches node:crypto at every message and padding boundary", () => {
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const input = "a".repeat(length);
    expect(sha256Hex(input)).toBe(oracle(input));
  }
});

test("matches node:crypto for text inside and outside the BMP, and for byte input", () => {
  const mixed = "na\u00efve caf\u00e9 \u6f22\u5b57 \ud83d\ude42 \u0440\u043e\u043a";
  expect(sha256Hex(mixed)).toBe(oracle(mixed));
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 253, 254, 255]);
  expect(sha256Hex(bytes)).toBe(oracle(bytes));
  expect(sha256Hex("abc")).toBe(sha256Hex(Uint8Array.from([97, 98, 99])));
});

test("encodes an unpaired surrogate the way this host's UTF-8 encoder does", () => {
  const unpaired = "a\ud800b\udc00c";
  expect(sha256Hex(unpaired)).toBe(oracle(unpaired));
});
