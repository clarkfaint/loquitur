/**
 * The reader's transport (F§10.4, F§5.7).
 *
 * One bar, three rows, and every control the contract names: the progress line, the two numbers of F§5.6(f),
 * the speed and the voice, previous and next sentence, play/pause, and the sleep timer. The bar owns no state
 * of its own beyond which sleep preset to offer next — the player's snapshot is the truth about everything it
 * draws, so a control that is not available is simply not pressable rather than pressable and inert.
 *
 * The arrangement is this unit's own (the contract requires one that is not the reference's): the progress line
 * runs the full width at the top, the transport sits on the row the thumb reaches first, and the two pickers
 * and the sleep chip share the row above it. The icons are drawn from views — bars and triangles — so no icon
 * font and no image asset enters the app (the contract's Forbidden Actions).
 *
 * Two states get the whole bar's attention rather than one control's: a spinner replaces the play/pause glyph
 * while the player is `loading` or `buffering` (F§5.7's two waiting states), and a failure replaces the
 * transport with its own sentence and a retry, which is the one thing F§5.7 says `play` does from `error`.
 */

import type { PlayerCommand, PlayerSnapshot } from "@lectern/core";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PlayerProgress } from "../player/player-context";
import { radius, type Theme, useTheme } from "../theme";

/** The sleep presets the chip cycles through, and `null` — the timer off — as the last one. */
export const SLEEP_PRESETS: readonly (number | null)[] = [15, 30, 45, null];

/** The states in which the transport cannot do anything yet (F§5.7). */
const INERT_STATES: readonly string[] = ["idle", "loading"];

/** The two states the spinner stands for (F§5.7's waiting states). */
const WAITING_STATES: readonly string[] = ["loading", "buffering"];

/** Two digits, so a clock reads `4:05` and not `4:5`. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** F§5.6(f)'s time remaining as a clock: `m:ss`, or `h:mm:ss` past an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** F§5.6(e)'s rate as the reader sees it: `1×`, `1.25×`, `4.5×` — never `1.00×`. */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** The preset after `current` in the cycle, which is `null` when the timer is off and 15 when it is not. */
export function nextSleepPreset(current: number | null): number | null {
  const index = SLEEP_PRESETS.indexOf(current);
  const next = SLEEP_PRESETS[(index + 1) % SLEEP_PRESETS.length];
  return next === undefined ? null : next;
}

/** A triangle drawn from borders, pointing the way its `direction` says. */
function Triangle({ color, direction }: { color: string; direction: "left" | "right" }) {
  return (
    <View style={direction === "right" ? { ...glyph.triangle, borderLeftColor: color } : { ...glyph.triangle, borderRightColor: color }} />
  );
}

/** Play: one triangle, pointing right. */
function PlayGlyph({ color }: { color: string }) {
  return <Triangle color={color} direction="right" />;
}

/** Pause: two bars. */
function PauseGlyph({ color }: { color: string }) {
  return (
    <View style={glyph.pair}>
      <View style={[glyph.bar, { backgroundColor: color }]} />
      <View style={[glyph.bar, { backgroundColor: color }]} />
    </View>
  );
}

/** Previous: a bar and a triangle pointing back at it. */
function PreviousGlyph({ color }: { color: string }) {
  return (
    <View style={glyph.pair}>
      <View style={[glyph.bar, { backgroundColor: color }]} />
      <Triangle color={color} direction="left" />
    </View>
  );
}

/** Next: a triangle pointing forward, and the bar it lands on. */
function NextGlyph({ color }: { color: string }) {
  return (
    <View style={glyph.pair}>
      <Triangle color={color} direction="right" />
      <View style={[glyph.bar, { backgroundColor: color }]} />
    </View>
  );
}

const glyph = StyleSheet.create({
  triangle: {
    width: 0,
    height: 0,
    borderTopWidth: 9,
    borderBottomWidth: 9,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftWidth: 13,
    borderRightWidth: 0,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  pair: { alignItems: "center", flexDirection: "row", gap: 4 },
  bar: { height: 16, width: 4 },
});

export interface PlayerBarNativeProps {
  /** F§5.7's snapshot: the state, the rate, the voice, the sleep timer and the failure. */
  snapshot: PlayerSnapshot;
  /** F§5.6(f)'s fraction and time remaining. */
  progress: PlayerProgress;
  /** The name of the voice in force, or `""` while none is chosen. */
  voiceLabel: string;
  /** Send one command to the controller (F§5.7). */
  onCommand(command: PlayerCommand): void;
  /** Open the speed sheet (F§5.6(e)). */
  onOpenSpeed(): void;
  /** Open the voice sheet (F§6). */
  onOpenVoice(): void;
}

/** `PlayerBarNative` — the reader's transport, progress and pickers. */
export function PlayerBarNative({ snapshot, progress, voiceLabel, onCommand, onOpenSpeed, onOpenVoice }: PlayerBarNativeProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const [sleepChoice, setSleepChoice] = useState<number | null>(null);

  // The player owns the timer, so the chip follows it: a timer that has run out or been cleared elsewhere
  // returns the cycle to its start rather than leaving a preset selected that nothing is counting down.
  useEffect(() => {
    if (snapshot.sleepRemainingMs === null) setSleepChoice(null);
  }, [snapshot.sleepRemainingMs]);

  const playing = snapshot.state === "playing" || snapshot.state === "buffering";
  const inert = INERT_STATES.includes(snapshot.state);
  const waiting = WAITING_STATES.includes(snapshot.state);
  const percent = Math.round(progress.fraction * 100);
  const sleepLabel = snapshot.sleepRemainingMs === null ? "Sleep" : formatClock(snapshot.sleepRemainingMs);

  return (
    <View style={[styles.bar, { paddingBottom: theme.spacing.three + insets.bottom }]}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>

      <View style={styles.row}>
        <Text style={styles.remaining}>{formatClock(progress.remainingMs)}</Text>
        <Text style={styles.percent}>{percent}%</Text>
        <View style={styles.spacer} />
        <Pressable style={styles.chip} onPress={onOpenSpeed} accessibilityRole="button" testID="speed-chip">
          <Text style={styles.chipText}>{formatRate(snapshot.rate)}</Text>
        </Pressable>
        <Pressable style={styles.chip} onPress={onOpenVoice} accessibilityRole="button" testID="voice-chip">
          <Text style={styles.chipText} numberOfLines={1}>
            {voiceLabel === "" ? "Voice" : voiceLabel}
          </Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable
          style={[styles.transport, inert ? styles.transportInert : null]}
          disabled={inert}
          onPress={() => onCommand({ type: "skip", sentences: -1 })}
          accessibilityRole="button"
          accessibilityLabel="Previous sentence"
          testID="previous"
        >
          <PreviousGlyph color={theme.colors.ink} />
        </Pressable>

        <Pressable
          style={styles.primary}
          disabled={inert}
          onPress={() => onCommand({ type: "toggle" })}
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause" : "Play"}
          testID="play-pause"
        >
          {waiting ? (
            <ActivityIndicator color={theme.colors.accentInk} />
          ) : playing ? (
            <PauseGlyph color={theme.colors.accentInk} />
          ) : (
            <PlayGlyph color={theme.colors.accentInk} />
          )}
        </Pressable>

        <Pressable
          style={[styles.transport, inert ? styles.transportInert : null]}
          disabled={inert}
          onPress={() => onCommand({ type: "skip", sentences: 1 })}
          accessibilityRole="button"
          accessibilityLabel="Next sentence"
          testID="next"
        >
          <NextGlyph color={theme.colors.ink} />
        </Pressable>

        <View style={styles.spacer} />

        <Pressable
          style={[styles.chip, sleepChoice === null ? null : styles.chipOn]}
          onPress={() => {
            const next = nextSleepPreset(sleepChoice);
            setSleepChoice(next);
            onCommand({ type: "setSleep", minutes: next });
          }}
          accessibilityRole="button"
          accessibilityLabel="Sleep timer"
          testID="sleep"
        >
          <Text style={styles.chipText}>{sleepLabel}</Text>
        </Pressable>
      </View>

      {snapshot.error === null ? null : (
        <View style={styles.error}>
          <Text style={styles.errorText}>{snapshot.error.message}</Text>
          <Pressable style={styles.retry} onPress={() => onCommand({ type: "play" })} accessibilityRole="button" testID="retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** The bar's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  const chip: ViewStyle = {
    alignItems: "center",
    backgroundColor: theme.colors.paper,
    borderColor: theme.colors.line,
    borderRadius: radius.three,
    borderWidth: 1,
    justifyContent: "center",
    maxWidth: 160,
    minHeight: theme.control.size,
    paddingHorizontal: theme.spacing.three,
  };
  return StyleSheet.create({
    bar: {
      backgroundColor: theme.colors.surface,
      borderTopColor: theme.colors.line,
      borderTopWidth: 1,
      gap: theme.spacing.two,
      paddingHorizontal: theme.spacing.four,
      paddingTop: theme.spacing.two,
    },
    track: {
      backgroundColor: theme.colors.line,
      borderRadius: radius.one,
      height: theme.control.progressHeight,
      overflow: "hidden",
    },
    fill: { backgroundColor: theme.colors.accent, height: theme.control.progressHeight },
    row: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two },
    spacer: { flex: 1 },
    remaining: { color: theme.colors.ink, fontSize: theme.type.label, fontVariant: ["tabular-nums"] },
    percent: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    chip,
    chipOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.ink, fontSize: theme.type.label },
    transport: {
      alignItems: "center",
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      height: theme.control.size + 8,
      justifyContent: "center",
      width: theme.control.size + 16,
    },
    transportInert: { opacity: 0.4 },
    primary: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size + 8,
      justifyContent: "center",
      width: theme.control.size + 32,
    },
    error: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two },
    errorText: { color: theme.colors.danger, flex: 1, fontSize: theme.type.caption },
    retry: {
      backgroundColor: theme.colors.accentSoft,
      borderRadius: radius.two,
      paddingHorizontal: theme.spacing.three,
      paddingVertical: theme.spacing.one,
    },
    retryText: { color: theme.colors.accent, fontSize: theme.type.label },
  });
}
