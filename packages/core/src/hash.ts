/**
 * SHA-256 (FIPS 180-4) in synchronous, pure TypeScript. F§5.2 derives every document identifier from
 * this digest, and the contract forbids `node:crypto`, `crypto.subtle` and hashing packages, so the
 * whole algorithm lives here: its own UTF-8 encoder, the message schedule, the 64-round compression
 * function, and the hexadecimal output.
 *
 * Two host-independent details are deliberate:
 *
 * - bytes are read through a `DataView` and never by indexing a typed array, because this repository
 *   compiles with `noUncheckedIndexedAccess`, under which a read at a computed index is
 *   `number | undefined`;
 * - every 32-bit value is reduced with `>>> 0` after a bitwise operation, because JavaScript's bitwise
 *   operators return a signed 32-bit integer, and a negative addend would silently corrupt the sums
 *   (`T1` and `T2` both add up to five 32-bit words, which stays inside the exact double range).
 */

const BLOCK_BYTES = 64;
const SCHEDULE_WORDS = 64;
const HEX_DIGITS_PER_WORD = 8;
const LENGTH_BYTES = 8;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const REPLACEMENT_CHARACTER_BYTES = [0xef, 0xbf, 0xbd];

/** The fractional parts of the cube roots of the first 64 primes (FIPS 180-4 §4.2.2). */
const ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** The first 32 bits of the fractional parts of the square roots of the first 8 primes (FIPS 180-4 §5.3.3). */
const INITIAL_STATE: State = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

type State = readonly [number, number, number, number, number, number, number, number];

/** A 32-bit right rotation. `shift` must be between 1 and 31. */
function rotateRight(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

/** UTF-8 bytes of a JS string, with surrogate pairs combined and unpaired surrogates replaced. */
export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) {
      const next = text.charCodeAt(index + 1);
      if (next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX) {
        const codePoint = 0x10000 + ((code - HIGH_SURROGATE_MIN) << 10) + (next - LOW_SURROGATE_MIN);
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
        index += 1;
      } else {
        bytes.push(...REPLACEMENT_CHARACTER_BYTES);
      }
    } else if (code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX) {
      bytes.push(...REPLACEMENT_CHARACTER_BYTES);
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    index += 1;
  }
  return Uint8Array.from(bytes);
}

/** `message` followed by `0x80`, zero padding, and the 64-bit big-endian bit length. */
function padMessage(message: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((message.length + 1 + LENGTH_BYTES) / BLOCK_BYTES) * BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  const bitLength = new DataView(padded.buffer);
  bitLength.setUint32(paddedLength - LENGTH_BYTES, Math.floor((message.length * 8) / 0x100000000), false);
  bitLength.setUint32(paddedLength - 4, (message.length * 8) >>> 0, false);
  return padded;
}

/**
 * One 64-byte block into the running state. `schedule` is this module's own scratch buffer: only this
 * function writes it, and it is written and read with the same byte order, so the host's endianness
 * cannot change the result. The block itself is read big-endian, as FIPS 180-4 requires.
 */
function compress(block: DataView, state: State, schedule: DataView): State {
  const [stateA, stateB, stateC, stateD, stateE, stateF, stateG, stateH] = state;
  let a = stateA;
  let b = stateB;
  let c = stateC;
  let d = stateD;
  let e = stateE;
  let f = stateF;
  let g = stateG;
  let h = stateH;

  for (let index = 0; index < 16; index += 1) {
    schedule.setUint32(index * 4, block.getUint32(index * 4, false), true);
  }
  for (let index = 16; index < SCHEDULE_WORDS; index += 1) {
    const word15 = schedule.getUint32((index - 15) * 4, true);
    const word2 = schedule.getUint32((index - 2) * 4, true);
    const small0 = (rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)) >>> 0;
    const small1 = (rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)) >>> 0;
    const word16 = schedule.getUint32((index - 16) * 4, true);
    const word7 = schedule.getUint32((index - 7) * 4, true);
    schedule.setUint32(index * 4, (word16 + small0 + word7 + small1) >>> 0, true);
  }

  for (const [round, constant] of ROUND_CONSTANTS.entries()) {
    const big1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
    const choose = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (h + big1 + choose + constant + schedule.getUint32(round * 4, true)) >>> 0;
    const big0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
    const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (big0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  return [
    (stateA + a) >>> 0,
    (stateB + b) >>> 0,
    (stateC + c) >>> 0,
    (stateD + d) >>> 0,
    (stateE + e) >>> 0,
    (stateF + f) >>> 0,
    (stateG + g) >>> 0,
    (stateH + h) >>> 0,
  ];
}

/** The lowercase hexadecimal SHA-256 digest of `input`; strings are encoded as UTF-8. */
export function sha256Hex(input: string | Uint8Array): string {
  const message = typeof input === "string" ? utf8Bytes(input) : input;
  const padded = padMessage(message);
  const schedule = new DataView(new Uint32Array(SCHEDULE_WORDS).buffer);
  let state = INITIAL_STATE;
  for (let offset = 0; offset < padded.byteLength; offset += BLOCK_BYTES) {
    state = compress(new DataView(padded.buffer, offset, BLOCK_BYTES), state, schedule);
  }
  return state.map((word) => word.toString(16).padStart(HEX_DIGITS_PER_WORD, "0")).join("");
}
