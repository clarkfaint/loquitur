/**
 * F§9's prompts: the four messages the summarization pipeline sends to the model — the system and user
 * messages of the map step, and the two of the reduce step, whose wording depends on the mode.
 *
 * The text here is Lectern's own. F§9 fixes what a prompt must ask for and how much it may ask for; it says
 * nothing about how to say it, so every sentence below is written for this product and no wording is taken
 * from anywhere else (the contract's *Forbidden Actions*, AGENTS.md §4).
 *
 * Two things are deliberately spelled out in the user message rather than left to the system message:
 * **the limits** (F§9's word and takeaway counts for the mode) and **the JSON shape** the reply must have.
 * A model that is told the object's exact keys needs no repair pass, and a reply whose keys are the ones
 * the parser expects is what keeps the validation below from being a guess.
 *
 * `PROMPT_VERSION` names this text. F§9 caches a summary under `(docId, mode, LLM_MODEL, promptVersion)`, so
 * a wording change is a version change: a summary written by an earlier wording is never served as if this
 * one had written it.
 */

import type { SummaryMode } from "@lectern/api-contract";

/** The version of the prompt text below (F§9). Bump it whenever any message in this file changes. */
export const PROMPT_VERSION = "1";

/** F§9's map ceiling: one segment yields at most this many bullet notes. */
export const MAP_NOTES = 8;

/** F§9's `brief` limits: a summary of at most this many words and exactly this many takeaways. */
const BRIEF_SUMMARY_WORDS = 120;
const BRIEF_TAKEAWAYS = 5;

/** F§9's `detailed` limits: a longer summary and a range of takeaways. */
const DETAILED_SUMMARY_WORDS = 400;
const DETAILED_MIN_TAKEAWAYS = 8;
const DETAILED_MAX_TAKEAWAYS = 10;

/** The JSON object the map step must answer with, as the prompt writes it. */
const MAP_SHAPE = '{"notes": ["the first note", "the second note"]}';

/** The JSON object the reduce step must answer with, as the prompt writes it. */
const REDUCE_SHAPE = '{"summary": "the summary", "keyTakeaways": ["the first takeaway", "the second takeaway"]}';

/**
 * One mode's own limits (F§9), as the sentence the reduce prompt states them in. `brief` asks for a count and
 * `detailed` for a range, which is exactly how F§9 words the two modes.
 */
const MODE_LIMITS: Record<SummaryMode, string> = {
  brief: `at most ${BRIEF_SUMMARY_WORDS} words in the summary and exactly ${BRIEF_TAKEAWAYS} key takeaways`,
  detailed: `at most ${DETAILED_SUMMARY_WORDS} words in the summary and between ${DETAILED_MIN_TAKEAWAYS} and ${DETAILED_MAX_TAKEAWAYS} key takeaways`,
};

/**
 * The map step's system message: the model's role for one passage of a longer document. It names no count and
 * no shape — those belong to the user message, where a case can read them back — and it asks for nothing but
 * the JSON object, because a model that also explains itself costs a retry.
 */
const MAP_SYSTEM = [
  "You are a research assistant taking notes on a long document, one passage at a time.",
  "You write short factual notes about what the passage says, in the order the passage says it.",
  "You never add a fact the passage does not carry, never comment on how it is written, and never write anything but the JSON object you are asked for.",
].join(" ");

/**
 * The reduce step's system message: the model's role for the whole document. The material may be the notes
 * taken from its passages, or — for a document short enough to need no notes — the document's own text, so the
 * message says which two things it may be given rather than assuming one of them.
 */
const REDUCE_SYSTEM = [
  "You are a research assistant writing the summary of a document.",
  "You are given material taken from it: either the notes made from its passages, or the text of a document short enough to need no notes.",
  "You use only what the material says, you never add a fact, you never mention the notes or this task, and you never write anything but the JSON object you are asked for.",
].join(" ");

/** The map step's system message (F§9). It carries no mode: F§9 asks the same notes of every segment. */
export function mapSystemMessage(): string {
  return MAP_SYSTEM;
}

/**
 * The map step's user message (F§9): the passage to take notes on, F§9's ceiling on how many notes it may
 * yield, and the JSON shape the reply must have.
 */
export function mapUserMessage(segment: string): string {
  return [
    "Read the passage below and write your notes on it.",
    "",
    "Reply with JSON only, in exactly this shape:",
    MAP_SHAPE,
    "",
    `The "notes" array holds at most ${MAP_NOTES} strings, each one a single self-contained sentence, and it may hold fewer.`,
    "Write nothing before or after the JSON object, and do not wrap it in a code fence.",
    "",
    "Passage:",
    segment,
  ].join("\n");
}

/** The reduce step's system message (F§9). The mode's limits are stated in the user message below. */
export function reduceSystemMessage(mode: SummaryMode): string {
  return `${REDUCE_SYSTEM} This document's summary is wanted in the ${mode} form.`;
}

/**
 * The reduce step's user message (F§9): the material the summary is written from, the mode, that mode's own
 * limits, and the JSON shape the reply must have.
 *
 * The mode is named in the message as well as its limits, because the two modes ask for different amounts and
 * a reply that overshoots one mode's range is a reply the other mode would have accepted.
 */
export function reduceUserMessage(mode: SummaryMode, material: readonly string[]): string {
  return [
    `Write the document's summary and its key takeaways from the material below, with ${MODE_LIMITS[mode]}.`,
    "",
    "Reply with JSON only, in exactly this shape:",
    REDUCE_SHAPE,
    "",
    'The "summary" is one string and the "keyTakeaways" array holds one string per takeaway, in the order they matter.',
    "Write nothing before or after the JSON object, and do not wrap it in a code fence.",
    "",
    `Mode: ${mode}.`,
    "",
    "Material:",
    ...material.map((entry) => `- ${entry}`),
  ].join("\n");
}
