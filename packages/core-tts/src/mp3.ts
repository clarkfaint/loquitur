/**
 * An MP3 duration reader written from the frame header's own tables. F§6 forbids a decoder here, so no
 * frame is ever decoded: a frame's header declares its bitrate, its sample rate and its length, and the
 * file's duration is the sum over its frames. Layer III only — that is what the hub's engines produce.
 *
 * The tables and the two frame-length formulas are F§6's, verbatim.
 */

/** The first three bytes of an ID3v2 tag, which sits in front of the frames of a tagged file. */
const ID3_MAGIC = [0x49, 0x44, 0x33] as const;
const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_BYTES = 10;
/** The ID3v2 header's flag bit that says a ten-byte footer follows the tag. */
const ID3_FOOTER_FLAG = 0x10;
/** The four bytes a frame header occupies; a frame is never shorter than its own header. */
const FRAME_HEADER_BYTES = 4;
/** The sync word's high bits: the rest of the eleven-bit sync lives in the second header byte. */
const SYNC_BYTE = 0xff;
const SYNC_HIGH_BITS = 0x07;
/** The header's version field: `0b11` MPEG-1, `0b10` MPEG-2, `0b00` MPEG-2.5, `0b01` reserved. */
const MPEG1_VERSION = 0x03;
const MPEG2_VERSION = 0x02;
/** The header's layer field: `0b01` is Layer III, the only layer this reader accepts. */
const LAYER_III = 0x01;
/** Samples per frame: 1152 for MPEG-1, 576 for MPEG-2 and MPEG-2.5 (F§6). */
const MPEG1_SAMPLES_PER_FRAME = 1152;
const MPEG2_SAMPLES_PER_FRAME = 576;
/** The frame-length coefficient: 144 for MPEG-1, 72 for MPEG-2 and MPEG-2.5 (F§6). */
const MPEG1_FRAME_COEFFICIENT = 144;
const MPEG2_FRAME_COEFFICIENT = 72;
/** Bitrates are in kbps, so a bitrate becomes bits per second through this factor. */
const BITS_PER_KBPS = 1000;

type MpegVersion = "mpeg1" | "mpeg2" | "mpeg25";

/** Sample rates in Hz by the header's two-bit index 0–2 (F§6); index 3 is invalid. */
const SAMPLE_RATES: Record<MpegVersion, readonly number[]> = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
};

/** Bitrates in kbps by the header's four-bit index 1–14, where 0 means free and 15 is invalid (F§6). */
const BITRATES: Record<MpegVersion, readonly number[]> = {
  mpeg1: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  mpeg25: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** One frame's own numbers: what it lasts and how many bytes it occupies. */
interface FrameShape {
  samples: number;
  sampleRate: number;
  length: number;
}

/** A table entry, or `null` when the index is outside the table (the header's reserved values). */
function pick(table: readonly number[], index: number): number | null {
  return table[index] ?? null;
}

/** The version a header's two-bit field names, or `null` when the field is the reserved one. */
function versionAt(bits: number): MpegVersion | null {
  if (bits === MPEG1_VERSION) return "mpeg1";
  if (bits === MPEG2_VERSION) return "mpeg2";
  if (bits === 0x00) return "mpeg25";
  return null;
}

/**
 * Read one frame header at `offset`, or answer `null` when the bytes there are not a Layer III frame.
 * The length formula is F§6's: `floor(144 · bitrate / sampleRate) + padding` for MPEG-1 and
 * `floor(72 · bitrate / sampleRate) + padding` for MPEG-2 and MPEG-2.5.
 */
function frameShapeAt(view: DataView, offset: number): FrameShape | null {
  if (offset + FRAME_HEADER_BYTES > view.byteLength) return null;
  if (view.getUint8(offset) !== SYNC_BYTE) return null;
  const second = view.getUint8(offset + 1);
  if (((second >> 5) & SYNC_HIGH_BITS) !== SYNC_HIGH_BITS) return null;
  if (((second >> 1) & 0x03) !== LAYER_III) return null;
  const version = versionAt((second >> 3) & 0x03);
  if (version === null) return null;
  const third = view.getUint8(offset + 2);
  const sampleRate = pick(SAMPLE_RATES[version], (third >> 2) & 0x03);
  const bitrate = pick(BITRATES[version], ((third >> 4) & 0x0f) - 1);
  if (sampleRate === null || bitrate === null) return null;
  const mpeg1 = version === "mpeg1";
  const coefficient = mpeg1 ? MPEG1_FRAME_COEFFICIENT : MPEG2_FRAME_COEFFICIENT;
  return {
    samples: mpeg1 ? MPEG1_SAMPLES_PER_FRAME : MPEG2_SAMPLES_PER_FRAME,
    sampleRate,
    length: Math.floor((coefficient * bitrate * BITS_PER_KBPS) / sampleRate) + ((third >> 1) & 0x01),
  };
}

/** How many bytes an ID3v2 tag in front of the frames occupies, or 0 when there is none. */
function id3TagBytes(view: DataView): number {
  if (view.byteLength < ID3_HEADER_BYTES) return 0;
  for (const [index, byte] of ID3_MAGIC.entries()) {
    if (view.getUint8(index) !== byte) return 0;
  }
  const flags = view.getUint8(5);
  // The tag's size is stored in four seven-bit bytes, most significant first.
  const size =
    ((view.getUint8(6) & 0x7f) << 21) | ((view.getUint8(7) & 0x7f) << 14) | ((view.getUint8(8) & 0x7f) << 7) | (view.getUint8(9) & 0x7f);
  const footer = (flags & ID3_FOOTER_FLAG) === 0 ? 0 : ID3_FOOTER_BYTES;
  return ID3_HEADER_BYTES + size + footer;
}

/**
 * `readMp3DurationMs(bytes)` — skip an ID3v2 tag, then walk the frames and sum what each one lasts.
 * Bytes with no Layer III frame at all are not audio, and say so rather than answering zero.
 */
export function readMp3DurationMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = id3TagBytes(view);
  let frames = 0;
  let seconds = 0;
  let shape = frameShapeAt(view, offset);
  while (shape !== null && shape.length > 0) {
    frames += 1;
    seconds += shape.samples / shape.sampleRate;
    offset += shape.length;
    shape = frameShapeAt(view, offset);
  }
  if (frames === 0) throw new Error("INVALID_MP3: no Layer III frame");
  return Math.round(seconds * 1000);
}
