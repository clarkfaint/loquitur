/**
 * The summary screen (F§10.4, F§9): the reader's way into a document's summary, and into hearing it.
 *
 * The screen owns the state F§9's routes do not — which mode the reader has chosen, what the hub last said
 * about it, and the one job that may be in flight. Four behaviours are worth naming.
 *
 * - **Opening the screen asks nothing.** It reads the hub's own state (`getSummary`) and draws what is there:
 *   a summary made earlier, or nothing at all. F§9's job is only ever started by the reader pressing the
 *   control, which is what keeps a reader from spending a model call by looking.
 * - **The mode is part of the question.** Switching it reads the hub's state for that mode, so a document with
 *   a cached brief summary shows it at once while the other mode shows whatever it has.
 * - **A job is waited for on F§9's schedule, and abandoned when the screen goes.** `waitForSummary` polls with
 *   the platform's clock until the job is done or has failed; leaving the screen, or switching mode, aborts
 *   the wait, so a screen that is gone cannot write a stale result into it. While it runs, the screen says how
 *   long it has been waiting.
 * - **The device never talks to the LLM endpoint.** F§9's prompts, model call and retries are the hub's, and
 *   this screen's only two calls are the hub's own two AI routes (F§7.2), through the same client the rest of
 *   the app uses.
 *
 * A finished summary is drawn as the hub wrote it — the summary paragraph, then its takeaways numbered — and
 * "Listen to summary" files it in the library and opens the reader on it (see `../src/ai/summary-service`).
 */

import { AiClientError } from "@lectern/api-client";
import { AiErrorCodeSchema, type AnySummaryResult, type SummaryError, type SummaryMode, type SummaryStatus } from "@lectern/api-contract";
import type { Clock } from "@lectern/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { aiClient, generate, listen } from "../../src/ai/summary-service";
import { radius, type Theme, useTheme } from "../../src/theme";

/** F§9's two modes, in the order the switch offers them, and the label each is offered under. */
const MODES: readonly SummaryMode[] = ["brief", "detailed"];
const MODE_LABELS: Readonly<Record<SummaryMode, string>> = { brief: "Brief", detailed: "Detailed" };

/** How often the running state's elapsed time is redrawn, in milliseconds. */
const TICK_MS = 1000;

/** The platform's clock: the one place this screen reads the time or schedules against it (F§5.7). */
const SCREEN_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** What the screen is showing: the hub's own four states, with its result and its failure. */
interface Phase {
  status: SummaryStatus["status"];
  result: AnySummaryResult | null;
  error: SummaryError | null;
}

/** The state the screen opens in, and the one a document with no summary is in. */
const NOTHING: Phase = { status: "none", result: null, error: null };

/** The hub's own state as this screen's. */
function phaseOf(status: SummaryStatus): Phase {
  return { status: status.status, result: status.result ?? null, error: status.error ?? null };
}

/**
 * A failure as F§9's error object: the hub's own code when it is one of F§9's, and this screen's reading of
 * "the endpoint could not be reached" otherwise.
 */
function problemOf(cause: unknown): SummaryError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof AiClientError) {
    const code = AiErrorCodeSchema.safeParse(cause.code);
    if (code.success) return { code: code.data, message };
  }
  return { code: "LLM_UNAVAILABLE", message };
}

/** How long the job has been running, as a reader reads it. */
function elapsedText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** One parameter of a route, which arrives as a string (or an array when the route repeats it). */
function parameterOf(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

export default function SummaryScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const params = useLocalSearchParams<{ docId?: string }>();
  const docId = parameterOf(params.docId);

  const [mode, setMode] = useState<SummaryMode>("brief");
  const [phase, setPhase] = useState<Phase>(NOTHING);
  const [elapsedMs, setElapsedMs] = useState(0);
  const waiting = useRef<AbortController | null>(null);
  const generation = useRef(0);

  /**
   * Read what the hub already holds for this document and mode, and draw it.
   *
   * A reader who presses the control while this read is in flight must not have the running state replaced by
   * the `none` this read was about to find, so every answer is dropped once another question has been asked.
   */
  useEffect(() => {
    if (docId === "") return;
    const asked = generation.current + 1;
    generation.current = asked;
    let live = true;
    void aiClient()
      .then((client) => client.getSummary(docId, mode))
      .then(
        (status) => {
          if (live && generation.current === asked) setPhase(phaseOf(status));
        },
        () => {
          // A read that failed is not a job that failed: the screen shows what it can and offers the control.
          if (live && generation.current === asked) setPhase(NOTHING);
        },
      );
    return () => {
      live = false;
      // A wait belongs to the question that started it: a new mode, or a screen that is going, abandons it.
      waiting.current?.abort();
    };
  }, [docId, mode]);

  /** The running state's clock: one tick a second for as long as the job is in flight. */
  useEffect(() => {
    if (phase.status !== "running") {
      setElapsedMs(0);
      return;
    }
    const startedAt = SCREEN_CLOCK.now();
    let handle = SCREEN_CLOCK.setTimeout(function tick(): void {
      setElapsedMs(SCREEN_CLOCK.now() - startedAt);
      handle = SCREEN_CLOCK.setTimeout(tick, TICK_MS);
    }, TICK_MS);
    return () => SCREEN_CLOCK.clearTimeout(handle);
  }, [phase.status]);

  /** Ask for a summary and follow the job to its end (F§9's schedule, F§9's ten minutes). */
  const ask = useCallback(async (): Promise<void> => {
    const asked = generation.current + 1;
    generation.current = asked;
    waiting.current?.abort();
    const controller = new AbortController();
    waiting.current = controller;
    setPhase({ status: "running", result: null, error: null });

    /** Everything this job says, for as long as it is still the question on screen. */
    const current = (status: SummaryStatus): void => {
      if (generation.current === asked) setPhase(phaseOf(status));
    };

    try {
      current(await generate(docId, mode));
      const client = await aiClient();
      current(await client.waitForSummary(docId, mode, { clock: SCREEN_CLOCK, onStatus: current, signal: controller.signal }));
    } catch (cause) {
      if (generation.current !== asked || controller.signal.aborted) return;
      setPhase({ status: "error", result: null, error: problemOf(cause) });
    } finally {
      if (waiting.current === controller) waiting.current = null;
    }
  }, [docId, mode]);

  /** File the finished summary and open it: `listen` navigates, so this screen is about to go. */
  const onListen = useCallback((): void => {
    void listen(docId, mode).catch((cause: unknown) => {
      setPhase({ status: "error", result: null, error: problemOf(cause) });
    });
  }, [docId, mode]);

  if (docId === "") {
    return (
      <View style={[styles.page, styles.centred]}>
        <Stack.Screen options={{ title: "Summary" }} />
        <Text style={styles.heading}>This link names no document</Text>
        <Text style={styles.hint}>Open a document from the library, then summarize it from the reader.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Summary" }} />

      <Text style={styles.hint}>
        The hub writes this summary with the model endpoint the operator configured. It is never asked for until you press the button.
      </Text>

      <View style={styles.modes}>
        {MODES.map((value) => (
          <Pressable
            key={value}
            style={[styles.chip, mode === value ? styles.chipOn : null]}
            onPress={() => setMode(value)}
            accessibilityRole="button"
            testID={`mode-${value}`}
          >
            <Text style={styles.chipText}>{MODE_LABELS[value]}</Text>
          </Pressable>
        ))}
      </View>

      {phase.status === "none" ? (
        <>
          <Text style={styles.hint} testID="summary-none">
            There is no summary of this document yet.
          </Text>
          <Pressable style={styles.button} onPress={() => void ask()} accessibilityRole="button" testID="generate-summary">
            <Text style={styles.buttonText}>Summarize</Text>
          </Pressable>
        </>
      ) : null}

      {phase.status === "running" ? (
        <View style={styles.running} testID="summary-running">
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>{`The hub is writing this summary… ${elapsedText(elapsedMs)}`}</Text>
        </View>
      ) : null}

      {phase.status === "error" && phase.error !== null ? (
        <View style={styles.failure} testID="summary-error">
          <Text style={styles.errorCode}>{phase.error.code}</Text>
          <Text style={styles.errorText}>{phase.error.message}</Text>
          <Pressable style={styles.button} onPress={() => void ask()} accessibilityRole="button" testID="retry-summary">
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {phase.status === "done" && phase.result !== null ? (
        <View style={styles.result} testID="summary-result">
          <Text style={styles.summary}>{phase.result.summary}</Text>
          {phase.result.keyTakeaways.map((takeaway, index) => (
            <View key={takeaway} style={styles.takeaway}>
              <Text style={styles.takeawayNumber}>{`${index + 1}.`}</Text>
              <Text style={styles.takeawayText}>{takeaway}</Text>
            </View>
          ))}
          <Text style={styles.model}>{`Written by ${phase.result.model}`}</Text>
          <Pressable style={styles.button} onPress={onListen} accessibilityRole="button" testID="listen-summary">
            <Text style={styles.buttonText}>Listen to summary</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

/** The screen's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper },
    content: { gap: theme.spacing.two, padding: theme.spacing.four, paddingBottom: theme.spacing.five },
    centred: { alignItems: "center", flex: 1, gap: theme.spacing.two, justifyContent: "center", padding: theme.spacing.five },
    heading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600", textAlign: "center" },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    modes: { flexDirection: "row", gap: theme.spacing.two },
    chip: {
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.three,
      borderWidth: 1,
      justifyContent: "center",
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.four,
    },
    chipOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.ink, fontSize: theme.type.label },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
      marginTop: theme.spacing.two,
      paddingHorizontal: theme.spacing.four,
    },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    running: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two, paddingVertical: theme.spacing.three },
    failure: {
      borderColor: theme.colors.danger,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.one,
      padding: theme.spacing.three,
    },
    errorCode: { color: theme.colors.danger, fontSize: theme.type.caption, fontWeight: "600" },
    errorText: { color: theme.colors.ink, fontSize: theme.type.caption },
    result: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.two,
      padding: theme.spacing.three,
    },
    summary: { color: theme.colors.ink, fontSize: theme.type.body, lineHeight: 24 },
    takeaway: { flexDirection: "row", gap: theme.spacing.two },
    takeawayNumber: { color: theme.colors.inkMuted, fontSize: theme.type.label, fontWeight: "600" },
    takeawayText: { color: theme.colors.ink, flexShrink: 1, fontSize: theme.type.label },
    model: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
  });
}
