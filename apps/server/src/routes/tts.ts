/**
 * `POST /v1/tts` and `GET /v1/tts/audio/:chunkId` (F§7.2, F§7.3): the hub's synthesis routes.
 *
 * The first answers what a client needs to start playing — the chunk's identity, its container, its length,
 * its word timings and where the bytes are served from — and the second serves those bytes, with the cache
 * header F§7.2 names and the byte ranges a media element asks for while it seeks.
 *
 * The chunk id names the chunk's audio exactly (F§6), so the id the route hands the cache is the id
 * `synthesizeChunk` computes inside it, and a request for the same text, voice and engine speed is one
 * synthesis however many clients ask for it.
 */

import { TtsRequestSchema, type TtsResponse, TtsResponseSchema } from "@lectern/api-contract";
import { chunkIdFor, synthesizeChunk } from "@lectern/core-tts";
import type { FastifyInstance } from "fastify";
import type { HubContext } from "../context";
import { describeIssues, HubError, messageOf } from "../errors";
import type { CachedChunk } from "../tts-cache";

/** F§6's chunk id: this many lowercase hexadecimal characters, and nothing else — a path never reaches the cache. */
const CHUNK_ID = /^[0-9a-f]{40}$/;

/** The one range form this hub answers (F§7.2): `bytes=start-end`, `bytes=start-` or `bytes=-suffix`. */
const RANGE = /^bytes=(\d*)-(\d*)$/;

/** The cache header F§7.2 names for a chunk, which never changes once it is written. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The request body `POST /v1/tts` reads, validated. */
function parseRequest(body: unknown) {
  const parsed = TtsRequestSchema.safeParse(body);
  if (!parsed.success) throw new HubError("BAD_REQUEST", `the request body is not a TTS request — ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** The bytes a range header asks for, or nothing when the request wants the whole chunk. */
interface ByteRange {
  start: number;
  end: number;
}

/**
 * `byteRangeOf(header, size)` — F§7.2's range support.
 *
 * A range that is malformed, multi-part, or does not fit the chunk answers `416`: the client asked for
 * something no byte of this chunk satisfies, and answering the whole chunk instead would hide that.
 */
function byteRangeOf(header: string | undefined, size: number): ByteRange | null {
  if (header === undefined) return null;
  const refuse = (): never => {
    throw new HubError("BAD_REQUEST", `the range ${JSON.stringify(header)} does not fit a ${size}-byte chunk`, 416);
  };
  const match = RANGE.exec(header.trim());
  if (match === null) refuse();
  const startText = match?.[1] ?? "";
  const endText = match?.[2] ?? "";
  if (startText === "" && endText === "") refuse();
  const suffixLength = startText === "" ? Number(endText) : null;
  const start = suffixLength === null ? Number(startText) : Math.max(size - suffixLength, 0);
  const end = suffixLength === null ? (endText === "" ? size - 1 : Math.min(Number(endText), size - 1)) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) refuse();
  return { start, end };
}

export function ttsRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.post("/v1/tts", async (request): Promise<TtsResponse> => {
    const body = parseRequest(request.body);
    const target = await ctx.engines.targetFor(body.voiceId);
    const chunkId = chunkIdFor(target.engine.id, target.voice.engineVoiceId, body.synthSpeed, body.text);
    let chunk: CachedChunk;
    try {
      chunk = await ctx.ttsCache.getOrCreate(chunkId, () =>
        synthesizeChunk(target.engine, { text: body.text, engineVoiceId: target.voice.engineVoiceId, synthSpeed: body.synthSpeed }),
      );
    } catch (cause) {
      throw new HubError("ENGINE_UNAVAILABLE", `the ${target.engine.id} engine could not synthesize this chunk — ${messageOf(cause)}`);
    }
    return TtsResponseSchema.parse({
      chunkId: chunk.chunkId,
      mime: chunk.mime,
      durationMs: chunk.durationMs,
      timings: chunk.timings,
      timingSource: chunk.timingSource,
      audioPath: `/v1/tts/audio/${chunk.chunkId}`,
    });
  });

  app.get<{ Params: { chunkId: string } }>("/v1/tts/audio/:chunkId", async (request, reply) => {
    const chunkId = request.params.chunkId;
    if (!CHUNK_ID.test(chunkId)) {
      throw new HubError("BAD_REQUEST", `a chunk id is 40 lowercase hexadecimal characters (F§6), not ${JSON.stringify(chunkId)}`);
    }
    const chunk = await ctx.ttsCache.read(chunkId);
    if (chunk === null) throw new HubError("NOT_FOUND", `no chunk is cached as ${chunkId}`);
    const size = chunk.bytes.length;
    reply.header("cache-control", IMMUTABLE);
    reply.header("accept-ranges", "bytes");
    reply.type(chunk.mime);
    const range = byteRangeOf(request.headers.range, size);
    if (range === null) return reply.send(chunk.bytes);
    reply.status(206);
    reply.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
    return reply.send(chunk.bytes.subarray(range.start, range.end + 1));
  });
}
