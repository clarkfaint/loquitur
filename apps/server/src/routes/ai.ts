/**
 * Phase 5's AI routes (F§7.2, F§9): asking for a document's summary, and reading the state of the job that
 * writes it.
 *
 * The routes are a skin over F§9's jobs (`../ai/jobs`): a request names a document and a mode, the hub stores the
 * document's model if the client sent one inline, and the answer is the job's state — `202` and `running` the
 * first time, the cached `done` result the second. Nothing here summarizes anything itself, and nothing here
 * holds state: the state is F§8.4's row, which is what makes polling a route rather than a connection.
 *
 * Four refusals this module owns, in the order a request meets them:
 *
 * - **`AI_DISABLED` (503)** when the hub has no LLM endpoint configured (F§7.1). The AI code set is not the
 *   shared one, so this is answered in the AI envelope's own shape rather than raised as a hub error the shared
 *   envelope would reject.
 * - **`BAD_REQUEST` (400)** when the body is not F§7.2's summary request, when the path's identifier is not
 *   F§5.2's shape, when `?mode=` is not one of F§9's two modes, or when an inline document describes a
 *   different document than the request names — the same rule the library routes apply to a model they are
 *   sent.
 * - **`MODEL_MISSING` (404)** when the request carries no inline document and the hub holds no model for it.
 *   A summary is written from the document's model, so a hub that has never been sent one has nothing to
 *   summarize.
 * - **`INTERRUPTED`** is not a refusal but a state: a `running` row left by a restart is marked `error` when
 *   this module registers, which is the hub's start-up (F§9).
 *
 * The inline document is stored gzipped, exactly as F§7.2's library route stores one, so the job reads a model
 * from one place whether the client uploaded it or sent it with the request.
 */

import {
  type AiErrorCode,
  DocIdParamSchema,
  SummaryErrorSchema,
  type SummaryMode,
  SummaryModeSchema,
  SummaryRequestSchema,
  SummaryStatusSchema,
} from "@lectern/api-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createSummaryJobs, type SummaryJobs } from "../ai/jobs";
import type { HubContext } from "../context";
import { describeIssues, HubError } from "../errors";

/** The status F§7.2's AI routes answer when this hub has no AI at all. */
const AI_DISABLED_STATUS = 503;

/** The status F§7.2's AI routes answer when the hub holds no model for the document asked about. */
const MODEL_MISSING_STATUS = 404;

/** F§7.2's `POST /v1/ai/summary` answers `202` with the job's state, whether it started one or found a cache. */
const ACCEPTED_STATUS = 202;

/** F§9's mode for a `GET` that names none. `brief` is the shorter read, which is what a caller who did not say wants. */
const DEFAULT_MODE: SummaryMode = "brief";

/**
 * What a result records as its model when the hub was never told one (F§7.1's `LLM_MODEL`). It is reachable only
 * when a caller hands the hub a provider of its own — the tests' seam — and F§9's result requires a non-empty
 * model name, so the honest answer is that none was configured rather than a guess.
 */
const UNRECORDED_MODEL = "unknown";

/** The subset of the host's `node:zlib` this module uses, reached by a specifier when a document is stored. */
interface HostZlib {
  gzipSync(buffer: Uint8Array): Uint8Array;
}

/** The host's zlib, reached through a `string`-typed specifier so this package's program keeps no Node ambient types. */
async function hostZlib(): Promise<HostZlib> {
  const specifier: string = "node:zlib";
  return (await import(specifier)) as HostZlib;
}

/** One refusal in the AI envelope's own shape (F§9), which is the shared envelope with the AI codes. */
function refuse(reply: FastifyReply, status: number, code: AiErrorCode, message: string): void {
  reply.status(status).send({ error: SummaryErrorSchema.parse({ code, message }) });
}

/** The document id in the path, refused before anything is read (F§5.2). */
function docIdOf(request: FastifyRequest<{ Params: { docId: string } }>): string {
  const parsed = DocIdParamSchema.safeParse(request.params.docId);
  if (!parsed.success) {
    throw new HubError(
      "BAD_REQUEST",
      `the document id in the path is not 32 lower-case hexadecimal characters (F§5.2): ${JSON.stringify(request.params.docId)}`,
    );
  }
  return parsed.data;
}

/** F§9's mode from the query string, or the default when the caller named none. */
function modeOf(query: unknown): SummaryMode {
  const source = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  const raw = source.mode;
  if (raw === undefined) return DEFAULT_MODE;
  const parsed = SummaryModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HubError(
      "BAD_REQUEST",
      `?mode= must be one of ${SummaryModeSchema.options.join(", ")} (F§9), received ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

/**
 * `aiRoutes(app, ctx)` — F§7.2's two AI routes, registered in the route registry.
 *
 * F§9's jobs are built here, once, from the context: the database, the document files, the provider F§7.1
 * configured and the model it named. A hub with no provider gets no jobs at all, which is what makes both routes
 * answer `AI_DISABLED` rather than pretending a summary could be written.
 *
 * `recoverInterrupted()` runs in the same breath, because this function runs while the app is being built: a row
 * that says `running` at that moment describes a job from a process that is no longer alive (F§9).
 */
export function aiRoutes(app: FastifyInstance, ctx: HubContext): void {
  const provider = ctx.llm;
  const jobs: SummaryJobs | null =
    provider === undefined
      ? null
      : createSummaryJobs({ db: ctx.db, files: ctx.files, provider, model: ctx.config.llmModel ?? UNRECORDED_MODEL, now: Date.now });
  jobs?.recoverInterrupted();

  app.post("/v1/ai/summary", async (request, reply): Promise<void> => {
    if (jobs === null) {
      refuse(reply, AI_DISABLED_STATUS, "AI_DISABLED", "this hub has no LLM endpoint configured (F§7.1), so it cannot summarize");
      return;
    }

    const parsed = SummaryRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HubError("BAD_REQUEST", `the body is not a summary request (F§7.2) — ${describeIssues(parsed.error)}`);
    const { docId, mode, document } = parsed.data;

    if (document !== undefined) {
      if (document.docId !== docId) {
        throw new HubError(
          "BAD_REQUEST",
          `the inline document describes the document ${document.docId}, not the one in the request (${docId})`,
        );
      }
      const zlib = await hostZlib();
      await ctx.files.putModel(docId, zlib.gzipSync(new TextEncoder().encode(JSON.stringify(document))));
    } else if (!(await ctx.files.hasModel(docId))) {
      refuse(reply, MODEL_MISSING_STATUS, "MODEL_MISSING", `this hub holds no model for the document ${docId} (F§8.4)`);
      return;
    }

    reply.status(ACCEPTED_STATUS).send(SummaryStatusSchema.parse(jobs.request(docId, mode)));
  });

  app.get<{ Params: { docId: string } }>("/v1/ai/summary/:docId", async (request, reply): Promise<void> => {
    if (jobs === null) {
      refuse(reply, AI_DISABLED_STATUS, "AI_DISABLED", "this hub has no LLM endpoint configured (F§7.1), so it cannot summarize");
      return;
    }
    const docId = docIdOf(request);
    const mode = modeOf(request.query);
    reply.send(SummaryStatusSchema.parse(jobs.status(docId, mode)));
  });
}
