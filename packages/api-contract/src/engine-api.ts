/**
 * Phase 1's engine routes (F§7.2): the health probe, the voice list, synthesis and parsing. Each schema is
 * the one shape both ends of a request agree on — a client builds a request with it, the hub validates an
 * answer with it — so the two cannot drift apart.
 *
 * Every value that already has an owner elsewhere is imported rather than re-spelled: F§5.1's
 * `DocumentModel` and `PdfAnchor` come from `@lectern/core`, F§6's `Voice` from `@lectern/core-tts`.
 */

import { DocumentModelSchema, PdfAnchorSchema } from "@lectern/core";
import { VoiceSchema } from "@lectern/core-tts";
import { z } from "zod";

/**
 * The header carrying a file's own name beside the raw bytes of `POST /v1/parse` (F§7.2's
 * `X-Lectern-Filename`). Lower case because a header name is case-insensitive and `Headers` compares it
 * case-insensitively anyway; the constant exists so the hub and a client spell the same name.
 */
export const FILENAME_HEADER = "x-lectern-filename";

/**
 * `GET /healthz` (F§7.2): the hub is answering, the version it runs, and the ids of the engines it has
 * enabled — `ok` is the field a client checks first, and `engines` names what it may ask for voices.
 */
export const HealthResponseSchema = z.strictObject({
  ok: z.boolean(),
  version: z.string().min(1),
  engines: z.array(z.string().min(1)),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * `GET /v1/voices` (F§7.2): F§6's `Voice` for every voice of every enabled engine, in one bare array — the
 * route's own listing, so a reader picks from the union of the engines' voices rather than from a cache it
 * has not seen yet.
 */
export const VoicesResponseSchema = z.array(VoiceSchema);
export type VoicesResponse = z.infer<typeof VoicesResponseSchema>;

/**
 * One word's media time inside a chunk: F§5.6's `WordTiming` (`i`, `s`, `e`) as a wire shape, in integer
 * milliseconds of media time, so a client holds the hub's timings to the same arithmetic the hub aligned them
 * with. The type is deliberately shape-identical to `@lectern/core`'s interface, so a validated response is
 * usable by the player without a conversion.
 */
export const WordTimingSchema = z.strictObject({
  i: z.int().nonnegative(),
  s: z.int().nonnegative(),
  e: z.int().nonnegative(),
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

/**
 * Where a chunk's timings came from (F§5.6(b) step 5): the engine's own timestamps, or `estimateTimings`
 * alone. A client may show a different highlight confidence for each, and nothing else is defined.
 */
export const TimingSourceSchema = z.enum(["engine", "estimated"]);
export type TimingSource = z.infer<typeof TimingSourceSchema>;

/**
 * `POST /v1/tts` (F§7.2): the text to speak (1 to 1 000 characters, by the same count a JavaScript string
 * reports), the `engine:voice` identifier to speak it with, and the engine-side speed.
 *
 * `synthSpeed` is optional and defaults to 1, which is what makes one cached chunk serve every ordinary
 * playback rate (F§5.6(e) keeps `synthSpeed` at 1.0 until the sink cannot reach the rate on its own); the
 * range 1.0–4.0 is the engine speed F§5.6(e)'s clamp allows. `voiceId` is checked for shape only: which
 * engines and voices exist is the hub's question, and it answers `UNKNOWN_VOICE` (F§7.2).
 */
export const TtsRequestSchema = z.strictObject({
  text: z.string().min(1).max(1000),
  voiceId: z.string().min(1),
  synthSpeed: z.number().min(1).max(4).default(1),
});
export type TtsRequest = z.infer<typeof TtsRequestSchema>;

/**
 * `POST /v1/tts` answer (F§7.2): the chunk's identity, the container the bytes are in (F§6's two audio
 * mimes), its length, its word timings with the source they came from, and the path that serves the audio —
 * `GET /v1/tts/audio/:chunkId`, whose answer a client fetches for the bytes themselves.
 */
export const TtsResponseSchema = z.strictObject({
  chunkId: z.string().min(1),
  mime: z.enum(["audio/mpeg", "audio/wav"]),
  durationMs: z.int().nonnegative(),
  timings: z.array(WordTimingSchema),
  timingSource: TimingSourceSchema,
  audioPath: z.string().min(1),
});
export type TtsResponse = z.infer<typeof TtsResponseSchema>;

/**
 * The JSON half of `POST /v1/parse` (F§7.2): either a URL for the hub to fetch, or text it reads directly —
 * exactly one of the two, because a body carrying both cannot say which one wins. `title` is the optional
 * display title for the text form; the raw-bytes form of the same route carries its name in the header above,
 * and `{ url }` fetches a page whose own title the parser takes.
 */
export const ParseJsonRequestSchema = z
  .strictObject({
    url: z.string().min(1).exactOptional(),
    text: z.string().min(1).exactOptional(),
    title: z.string().exactOptional(),
  })
  .refine((body) => (body.url === undefined) !== (body.text === undefined), {
    error: "exactly one of `url` or `text` is required, never both",
    path: ["url"],
  });
export type ParseJsonRequest = z.infer<typeof ParseJsonRequestSchema>;

/**
 * `POST /v1/parse` answer (F§7.2): F§5.1's whole `DocumentModel`, and the `PdfAnchor`s a paged source gave
 * its sentences (F§5.4) — absent for a source with no pages to point into, which is every format but PDF.
 */
export const ParseResponseSchema = z.strictObject({
  document: DocumentModelSchema,
  anchors: z.array(PdfAnchorSchema).exactOptional(),
});
export type ParseResponse = z.infer<typeof ParseResponseSchema>;
