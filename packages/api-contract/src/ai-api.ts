/**
 * Phase 5's AI routes (F§7.2, F§9): asking for a summary of one document, and reading the state of the job
 * that writes it.
 *
 * The result schema is a function of the mode rather than one shape, because F§9 gives `brief` and
 * `detailed` different ceilings and both are deliberately looser than what the prompt asks for — a small
 * overshoot by a model must not fail a job, but a result outside the ceilings must.
 */

import { DocumentModelSchema } from "@lectern/core";
import { z } from "zod";
import { ErrorBodySchema } from "./common";
import { DocIdParamSchema } from "./library-api";

/** F§9's two summary modes: a short read, and a longer one. */
export const SummaryModeSchema = z.enum(["brief", "detailed"]);
export type SummaryMode = z.infer<typeof SummaryModeSchema>;

/**
 * F§9's validation ceilings per mode — the loosest a model's answer may be before the hub calls it invalid.
 * They sit above the prompt's own request (≤ 120 words and 5 takeaways for `brief`, ≤ 400 words and 8–10 for
 * `detailed`) on purpose, so a reply that overshoots the request a little is still a usable summary.
 */
export const SUMMARY_LIMITS: Record<SummaryMode, { summaryChars: number; minTakeaways: number; maxTakeaways: number }> = {
  brief: { summaryChars: 1200, minTakeaways: 3, maxTakeaways: 6 },
  detailed: { summaryChars: 4000, minTakeaways: 6, maxTakeaways: 12 },
};

/**
 * The result one mode's job must satisfy (F§9): the summary, its takeaways, the model that wrote them, the
 * prompt version that asked for them, and when they were made.
 *
 * It is a function of the mode because the ceilings differ — a `brief` result with seven takeaways is not a
 * `detailed` result, it is an invalid `brief` one — and the caller always knows which mode it asked for.
 */
export function SummaryResultSchema(mode: SummaryMode) {
  const limits = SUMMARY_LIMITS[mode];
  return z.strictObject({
    summary: z.string().min(1).max(limits.summaryChars),
    keyTakeaways: z.array(z.string().min(1)).min(limits.minTakeaways).max(limits.maxTakeaways),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    createdAt: z.number(),
  });
}
export type SummaryResult = z.infer<ReturnType<typeof SummaryResultSchema>>;

/**
 * A result whose mode is not known where it is read — what a stored status carries, since F§8.4 keeps the
 * mode in its own column beside the result rather than inside it. It accepts either mode's result and
 * nothing wider.
 */
export const AnySummaryResultSchema = z.union([SummaryResultSchema("brief"), SummaryResultSchema("detailed")]);
export type AnySummaryResult = z.infer<typeof AnySummaryResultSchema>;

/**
 * `POST /v1/ai/summary` (F§7.2): the document to summarize, the mode to summarize it in, and — optionally —
 * the document's own model, which the hub stores as that document's model so a summary works without sync.
 */
export const SummaryRequestSchema = z.strictObject({
  docId: DocIdParamSchema,
  mode: SummaryModeSchema,
  document: DocumentModelSchema.exactOptional(),
});
export type SummaryRequest = z.infer<typeof SummaryRequestSchema>;

/**
 * F§9's AI failures: no model provider is configured, the provider could not be reached or could not be
 * read, the model's answer never validated, a job was cut short by a restart, and the document's model is
 * not on the hub. The list is closed, like every other code set in this package.
 */
export const AiErrorCodeSchema = z.enum(["AI_DISABLED", "LLM_UNAVAILABLE", "LLM_INVALID_OUTPUT", "INTERRUPTED", "MODEL_MISSING"]);
export type AiErrorCode = z.infer<typeof AiErrorCodeSchema>;

/**
 * F§7.2's error object (`{ code, message }`, `./common`) carrying the AI code set above, so a summary's
 * state can name why it failed with a code the shared envelope has no entry for.
 */
export const SummaryErrorSchema = ErrorBodySchema.shape.error.extend({ code: AiErrorCodeSchema });
export type SummaryError = z.infer<typeof SummaryErrorSchema>;

/**
 * `GET /v1/ai/summary/:docId?mode=` (F§7.2, F§9): the job's state, its result once it is done, and the
 * failure once it is not. `none` means no job has ever been asked for; a `running` row left behind by a
 * restart becomes `error` with `INTERRUPTED` (F§9). Both fields are optional because `none` and `running`
 * carry neither.
 */
export const SummaryStatusSchema = z.strictObject({
  status: z.enum(["none", "running", "done", "error"]),
  result: AnySummaryResultSchema.exactOptional(),
  error: SummaryErrorSchema.exactOptional(),
});
export type SummaryStatus = z.infer<typeof SummaryStatusSchema>;
