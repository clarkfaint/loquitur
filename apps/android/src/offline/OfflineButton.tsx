/**
 * One library row's offline control (F§10.4, F§10.1).
 *
 * Download the document, watch it happen, stop it, finish it, and take it away again. The control owns no state
 * of its own beyond what it is doing this moment: whether a document has a pack is F§5.9's record, so the
 * control asks the store when the row appears and again after every action, which is what makes a document
 * packed in an earlier session read as packed here too.
 *
 * Five states are drawn, and one of them is not the record's:
 *
 * - `none` — F§10.1's "download for offline", under the row it belongs to;
 * - downloading — the percentage in place of the state, and a Cancel that really stops the loop;
 * - `partial` — a pin the cache has not caught up with, which offers to **finish** rather than pretending to be
 *   done, because a download the reader stopped is exactly this state;
 * - `complete` — F§10.4's offline promise kept, and the way back is Remove;
 * - a failure — the hub's own sentence, or the connection's, beside the control that caused it.
 *
 * The controls are siblings of the row's own pressable rather than its children, so a reader's thumb on
 * "Offline" cannot open the reader and the accessibility tree keeps the control its own node.
 */

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radius, type Theme, useTheme } from "../theme";
import {
  downloadForOffline,
  isDownloadCancelled,
  type OfflineProgress,
  type OfflineState,
  offlineState,
  removeOffline,
} from "./offline-service";

/** What one row's offline control is told about the document it belongs to. */
export interface OfflineButtonProps {
  docId: string;
  title: string;
}

/** How far a download has got, as the row shows it. */
function asPercent(progress: OfflineProgress): string {
  return progress.total === 0 ? "Starting…" : `${Math.round((progress.done / progress.total) * 100)}%`;
}

/** The words for a failure, which is the hub's own when it answered with one. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The sentence a state shows, for the two states that have one — a download shows its own percentage. */
function stateLabel(state: OfflineState): string | null {
  if (state === "complete") return "Ready offline";
  if (state === "partial") return "Partly saved";
  return null;
}

export function OfflineButton({ docId, title }: OfflineButtonProps): ReactElement {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [state, setState] = useState<OfflineState>("none");
  const [progress, setProgress] = useState<OfflineProgress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);

  // The state is a record, not a memory: it is read when the row appears, so a document packed in an earlier
  // session reads as packed here too, and so does one packed on another screen.
  useEffect(() => {
    let live = true;
    void offlineState(docId)
      .then((read) => {
        if (live) setState(read);
      })
      .catch((cause: unknown) => {
        if (live) setProblem(messageOf(cause));
      });
    return () => {
      live = false;
    };
  }, [docId]);

  // A row that leaves the screen takes its download with it: the loop is stopped rather than left asking the
  // hub for sentences nobody is waiting for.
  useEffect(
    () => () => {
      running.current?.abort();
    },
    [],
  );

  /** Read the record back, so the control shows what the store now holds. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await offlineState(docId));
    } catch (cause) {
      setProblem(messageOf(cause));
    }
  }, [docId]);

  const download = useCallback(async (): Promise<void> => {
    setProblem(null);
    setProgress({ done: 0, total: 0 });
    const controller = new AbortController();
    running.current = controller;
    try {
      await downloadForOffline(docId, (next) => setProgress(next), controller.signal);
    } catch (cause) {
      // A cancel is the reader's own doing and is not a failure; the record read below is what shows what is
      // left of the pack — `partial`, which offers to be finished.
      if (!isDownloadCancelled(cause)) setProblem(messageOf(cause));
    } finally {
      running.current = null;
      setProgress(null);
    }
    await refresh();
  }, [docId, refresh]);

  const remove = useCallback(async (): Promise<void> => {
    setProblem(null);
    try {
      await removeOffline(docId);
    } catch (cause) {
      setProblem(messageOf(cause));
    }
    await refresh();
  }, [docId, refresh]);

  const downloading = progress !== null;
  const status = progress === null ? stateLabel(state) : asPercent(progress);

  return (
    <View style={styles.controls}>
      {status === null ? null : (
        <Text style={styles.status} testID={`offline-state-${docId}`}>
          {status}
        </Text>
      )}

      {problem === null ? null : (
        <Text style={styles.problem} testID={`offline-problem-${docId}`}>
          {problem}
        </Text>
      )}

      {downloading || state === "complete" ? null : (
        <Pressable
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={state === "none" ? `Download ${title} for offline` : `Finish downloading ${title}`}
          onPress={() => void download()}
          testID={`offline-${state === "none" ? "download" : "finish"}-${docId}`}
        >
          <Text style={styles.buttonText}>{state === "none" ? "Offline" : "Finish"}</Text>
        </Pressable>
      )}

      {downloading ? (
        <Pressable
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={`Cancel downloading ${title}`}
          onPress={() => running.current?.abort()}
          testID={`offline-cancel-${docId}`}
        >
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
      ) : null}

      {downloading || state === "none" ? null : (
        <Pressable
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={`Remove the offline copy of ${title}`}
          onPress={() => void remove()}
          testID={`offline-remove-${docId}`}
        >
          <Text style={styles.buttonText}>Remove</Text>
        </Pressable>
      )}
    </View>
  );
}

/** The control's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    controls: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.two },
    status: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    problem: { color: theme.colors.danger, fontSize: theme.type.caption },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.paper,
      borderColor: theme.colors.line,
      borderRadius: radius.three,
      borderWidth: 1,
      justifyContent: "center",
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.four,
    },
    buttonText: { color: theme.colors.ink, fontSize: theme.type.label },
  });
}
