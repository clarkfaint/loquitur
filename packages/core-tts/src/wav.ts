/**
 * A WAV writer and a WAV duration reader, written from the container's own fields. F§6 forbids an audio
 * encoding package here, so the header is assembled by hand: what the writer emits is what F§6's mock
 * engine promises (16-bit mono PCM), and what the reader accepts is any RIFF/WAVE file, whatever chunks
 * it carries and in whatever order.
 */

/** The canonical header: `RIFF`+size, `WAVE`, `fmt `+16 bytes, `data`+size. */
const HEADER_BYTES = 44;
/** The `WAVE` format tag for uncompressed PCM. */
const PCM_FORMAT = 1;
const MONO = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
/** One sample frame, one channel wide. */
const BLOCK_ALIGN = MONO * BYTES_PER_SAMPLE;
/** The `fmt ` chunk's own size: two 16-bit fields, two 32-bit fields, two 16-bit fields. */
const FMT_CHUNK_BYTES = 16;
const CHUNK_ID_BYTES = 4;
const CHUNK_SIZE_BYTES = 4;
/** Where the byte rate sits inside `fmt `, after the format tag, the channel count and the sample rate. */
const BYTE_RATE_OFFSET = 8;
/** `RIFF`, its size and `WAVE`, before the first chunk. */
const WAVE_DESCRIPTOR_BYTES = 12;

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

function asciiAt(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(offset + index));
  return text;
}

/**
 * `encodeWavPcm16(samples, sampleRate)` — one mono 16-bit PCM RIFF/WAVE file of `samples`, little-endian
 * as the format requires. Every derived field (`byteRate`, the two chunk sizes, the `RIFF` size) is
 * computed from the sample count, so a caller cannot hand out a file whose header disagrees with its data.
 */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, FMT_CHUNK_BYTES, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, MONO, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BLOCK_ALIGN, true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (const [index, sample] of samples.entries()) view.setInt16(HEADER_BYTES + index * BYTES_PER_SAMPLE, sample, true);
  return bytes;
}

/** What one walk over the chunk list yields: the byte rate `fmt ` declares and the `data` chunk's size. */
interface WavChunkDirectory {
  byteRate: number;
  dataBytes: number;
}

/**
 * Walk the chunks once, following each one's declared size, and read the two fields the duration needs.
 * A chunk this package knows nothing about (`LIST`, `fact`, an encoder's own) is stepped over, which is
 * how a file another tool wrote reads the same as one this package wrote itself.
 */
function readChunkDirectory(view: DataView): WavChunkDirectory {
  const directory: WavChunkDirectory = { byteRate: 0, dataBytes: -1 };
  let offset = WAVE_DESCRIPTOR_BYTES;
  while (offset + CHUNK_ID_BYTES + CHUNK_SIZE_BYTES <= view.byteLength) {
    const id = asciiAt(view, offset, CHUNK_ID_BYTES);
    const size = view.getUint32(offset + CHUNK_ID_BYTES, true);
    const body = offset + CHUNK_ID_BYTES + CHUNK_SIZE_BYTES;
    if (id === "fmt " && body + FMT_CHUNK_BYTES <= view.byteLength) {
      directory.byteRate = view.getUint32(body + BYTE_RATE_OFFSET, true);
    } else if (id === "data") {
      directory.dataBytes = Math.min(size, view.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  return directory;
}

/**
 * `readWavDurationMs(bytes)` — the duration the `data` chunk's byte rate implies, in whole milliseconds.
 * Bytes that declare no usable `fmt ` or no `data` at all are not audio this package can play, and say so
 * rather than answering a duration derived from nothing.
 */
export function readWavDurationMs(bytes: Uint8Array): number {
  const directory = readChunkDirectory(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (directory.byteRate <= 0) throw new Error("INVALID_WAV: no fmt chunk with a byte rate");
  if (directory.dataBytes < 0) throw new Error("INVALID_WAV: no data chunk");
  return Math.round((directory.dataBytes / directory.byteRate) * 1000);
}
