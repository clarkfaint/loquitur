/**
 * The player protocol (F§5.7): the states the reader can be in, the commands that move it between them,
 * and the snapshot every view renders. The schemas are the runtime form of the same three declarations,
 * so a command that crosses a process or extension boundary is validated with the exact shape the
 * controller accepts.
 */

import { z } from "zod";
import { PositionSchema } from "../model";

/** The eight states a player can be in (F§5.7). */
export const PlayerStateSchema = z.enum(["idle", "loading", "ready", "buffering", "playing", "paused", "ended", "error"]);
export type PlayerState = z.infer<typeof PlayerStateSchema>;

/** Everything a caller can ask the player to do (F§5.7). */
export const PlayerCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("load"), docId: z.string(), position: PositionSchema.exactOptional() }),
  z.strictObject({ type: z.literal("play") }),
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("toggle") }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({
    type: z.literal("seek"),
    sentenceIndex: z.int().nonnegative(),
    wordIndex: z.int().nonnegative().exactOptional(),
  }),
  z.strictObject({ type: z.literal("skip"), sentences: z.int() }),
  z.strictObject({ type: z.literal("setRate"), rate: z.number() }),
  z.strictObject({ type: z.literal("setVoice"), voiceId: z.string() }),
  z.strictObject({ type: z.literal("setSleep"), minutes: z.number().nullable() }),
]);
export type PlayerCommand = z.infer<typeof PlayerCommandSchema>;

/** What a view renders, and what a subscriber receives on every change (F§5.7). */
export const PlayerSnapshotSchema = z.strictObject({
  state: PlayerStateSchema,
  docId: z.string().nullable(),
  sentenceIndex: z.int().nonnegative(),
  wordIndex: z.int().nonnegative(),
  rate: z.number(),
  voiceId: z.string().nullable(),
  sleepRemainingMs: z.int().nonnegative().nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
