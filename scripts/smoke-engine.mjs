#!/usr/bin/env node
// Lectern engine smoke test (U-022). Zero dependencies: Node's own fetch only.
//
//   node scripts/smoke-engine.mjs --base http://127.0.0.1:8787
//
// Exercises a running hub against the real engines the compose stack starts: the health probe, the
// voice list, one synthesis with word timings, the audio download and one text parse. Every check
// prints a line; the first failure ends the run with exit code 1.

const USAGE = "Usage: node scripts/smoke-engine.mjs --base <url>";

/** The text the timing check asks for, so the word count it expects is fixed. */
const TIMING_TEXT = "Hello, world.";
/** F§5.3's word splitter reads this as two words; the hub answers one timing per word. */
const TIMING_WORDS = 2;
/** The text the parse check sends: one sentence, so the count it expects is fixed. */
const PARSE_TEXT = "Lectern reads a document aloud.";
/** The floor the audio download must clear (the contract names 1 000 bytes). */
const MIN_AUDIO_BYTES = 1000;

/** A failure with the check it belongs to, so the run can say which check stopped it. */
class SmokeFailure extends Error {}

/** `--base <url>`, and the token the hub expects, from the environment the operator exports. */
function parseArguments(argv) {
  const index = argv.indexOf("--base");
  if (index === -1 || argv[index + 1] === undefined || argv[index + 1].startsWith("-")) {
    throw new SmokeFailure(USAGE);
  }
  return { base: argv[index + 1].replace(/\/+$/, "") };
}

/** One check's outcome, printed as it happens: `OK  <what was proved>`. */
function ok(message) {
  process.stdout.write(`OK    ${message}\n`);
}

/** The first failure ends the run: `FAIL <what was asked> — <why>`. */
function fail(message) {
  process.stdout.write(`FAIL  ${message}\n`);
}

/** One request to the hub: the bearer token, JSON in, JSON out, and a status the caller can read. */
async function request(base, token, path, init = {}) {
  const headers = { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) };
  const answer = await fetch(`${base}${path}`, { ...init, headers });
  if (!answer.ok) {
    const body = await answer.text();
    throw new SmokeFailure(`${path} answered HTTP ${answer.status}: ${body.slice(0, 200)}`);
  }
  return answer;
}

/** The JSON body of a hub answer, with a readable failure when it is not JSON at all. */
async function requestJson(base, token, path, init) {
  const answer = await request(base, token, path, init);
  const text = await answer.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeFailure(`${path} answered no readable JSON: ${text.slice(0, 200)}`);
  }
}

/** The health probe: the hub is up and says so. */
async function checkHealth(base, token) {
  const body = await requestJson(base, token, "/healthz");
  if (body.ok !== true) throw new SmokeFailure(`/healthz answered ok=${JSON.stringify(body.ok)}`);
  ok(`/healthz ok (version ${String(body.version)}, engines ${JSON.stringify(body.engines)})`);
}

/** The voice list: at least one voice from a real engine, and the first one the timing check uses. */
async function checkVoices(base, token) {
  const body = await requestJson(base, token, "/v1/voices");
  if (!Array.isArray(body)) throw new SmokeFailure(`/v1/voices answered ${typeof body}, not a voice list`);
  const kokoro = body.find((voice) => typeof voice?.id === "string" && voice.id.startsWith("kokoro:"));
  if (kokoro === undefined) {
    throw new SmokeFailure(`/v1/voices carries no kokoro: voice (${body.length} voice(s): ${body.map((v) => v?.id).join(", ")})`);
  }
  ok(`/v1/voices lists ${body.length} voice(s), first kokoro voice ${kokoro.id}`);
  return kokoro.id;
}

/** One synthesis: the engine timed the words, so the answer is not an estimate. */
async function checkTimings(base, token, voiceId) {
  const body = await requestJson(base, token, "/v1/tts", {
    method: "POST",
    body: JSON.stringify({ text: TIMING_TEXT, voiceId }),
  });
  const timings = body.timings;
  if (!Array.isArray(timings)) throw new SmokeFailure(`/v1/tts answered no timings array`);
  if (body.timingSource !== "engine") {
    throw new SmokeFailure(`/v1/tts answered timingSource ${JSON.stringify(body.timingSource)} for ${TIMING_TEXT}`);
  }
  if (timings.length !== TIMING_WORDS) {
    throw new SmokeFailure(`/v1/tts answered ${timings.length} timing(s) for ${TIMING_WORDS} word(s)`);
  }
  ok(`/v1/tts timed ${timings.length} word(s) from the engine (${body.durationMs} ms, ${body.mime})`);
  return body;
}

/** The audio the synthesis wrote: the same chunk, served as bytes. */
async function checkAudio(base, token, chunkId) {
  const answer = await request(base, token, `/v1/tts/audio/${chunkId}`);
  const bytes = new Uint8Array(await answer.arrayBuffer());
  if (bytes.byteLength <= MIN_AUDIO_BYTES) {
    throw new SmokeFailure(`the audio download is ${bytes.byteLength} byte(s), not more than ${MIN_AUDIO_BYTES}`);
  }
  ok(`/v1/tts/audio/${chunkId} served ${bytes.byteLength} byte(s)`);
}

/** One parse: text in, one sentence out. */
async function checkParse(base, token) {
  const body = await requestJson(base, token, "/v1/parse", {
    method: "POST",
    body: JSON.stringify({ text: PARSE_TEXT }),
  });
  const blocks = body?.document?.blocks;
  if (!Array.isArray(blocks)) throw new SmokeFailure("/v1/parse answered no document blocks");
  const sentences = blocks.reduce((total, block) => total + (Array.isArray(block?.sentences) ? block.sentences.length : 0), 0);
  if (sentences !== 1) throw new SmokeFailure(`/v1/parse answered ${sentences} sentence(s) for one sentence of text`);
  ok(`/v1/parse read ${sentences} sentence from text (docId ${String(body.document.docId).slice(0, 12)}…)`);
}

async function main() {
  const { base } = parseArguments(process.argv.slice(2));
  const token = process.env.LECTERN_TOKEN;
  if (token === undefined || token === "") throw new SmokeFailure("LECTERN_TOKEN is not set");
  process.stdout.write(`Lectern engine smoke test against ${base}\n`);
  await checkHealth(base, token);
  const voiceId = await checkVoices(base, token);
  const synthesis = await checkTimings(base, token, voiceId);
  await checkAudio(base, token, synthesis.chunkId);
  await checkParse(base, token);
  process.stdout.write("smoke: every check passed\n");
}

try {
  await main();
} catch (cause) {
  fail(cause instanceof SmokeFailure ? cause.message : `unexpected failure: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
