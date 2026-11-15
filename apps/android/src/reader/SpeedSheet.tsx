/**
 * The speed control (F§5.6(e)).
 *
 * F§5.6(e) offers the reader one number between 0.5 and 5.0 in steps of 0.05, with five presets worth reaching
 * in one press. A bottom sheet holds both: the presets as chips, and a pair of steps that walk the whole range a
 * hundredth of a notch at a time. Every value is put through the model's own `clampRate`, so the control cannot
 * offer a rate the player would refuse.
 *
 * The sheet also says what the platform is doing with a rate above its own ceiling — F§5.8's Android sink plays
 * at most 2×, so `planSpeed` splits anything faster between the synthesizer and the queue. That is the one piece
 * of F§5.6(e) a reader can actually hear, and hiding it would make a cached chunk's higher synthesis speed look
 * like a mystery.
 */

import { clampRate, planSpeed, RATE_MAX, RATE_MIN, RATE_PRESETS, RATE_STEP } from "@lectern/core";
import { useMemo } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { DEFAULT_SINK_MAX_RATE } from "../audio/expo-queue-sink";
import { radius, type Theme, useTheme } from "../theme";

/** The rate one step away from `rate`, snapped onto F§5.6(e)'s 0.05 grid and held inside its range. */
export function steppedRate(rate: number, direction: -1 | 1): number {
  return clampRate(Number((rate + direction * RATE_STEP).toFixed(2)));
}

export interface SpeedSheetProps {
  /** Whether the sheet is up. */
  visible: boolean;
  /** The rate in force (F§5.7's snapshot). */
  rate: number;
  /** Choose a rate: the player is asked to `setRate` (F§5.6(e)). */
  onSelect(rate: number): void;
  /** Put the sheet away. */
  onClose(): void;
}

/** `SpeedSheet` — F§5.6(e)'s five presets and its 0.05 step, over the reader's own text. */
export function SpeedSheet({ visible, rate, onSelect, onClose }: SpeedSheetProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const plan = planSpeed(rate, DEFAULT_SINK_MAX_RATE);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the speed control" />
      <View style={styles.sheet}>
        <Text style={styles.heading}>Speed</Text>

        <View style={styles.stepper}>
          <Pressable
            style={[styles.step, rate <= RATE_MIN ? styles.stepOff : null]}
            disabled={rate <= RATE_MIN}
            onPress={() => onSelect(steppedRate(rate, -1))}
            accessibilityRole="button"
            accessibilityLabel="Slower"
            testID="speed-slower"
          >
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <Text style={styles.value}>{`${Number(rate.toFixed(2))}×`}</Text>
          <Pressable
            style={[styles.step, rate >= RATE_MAX ? styles.stepOff : null]}
            disabled={rate >= RATE_MAX}
            onPress={() => onSelect(steppedRate(rate, 1))}
            accessibilityRole="button"
            accessibilityLabel="Faster"
            testID="speed-faster"
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets}>
          {RATE_PRESETS.map((preset) => (
            <Pressable
              key={preset}
              style={[styles.chip, preset === rate ? styles.chipOn : null]}
              onPress={() => onSelect(preset)}
              accessibilityRole="button"
              testID={`speed-preset-${preset}`}
            >
              <Text style={styles.chipText}>{`${preset}×`}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={styles.hint}>
          {plan.synthSpeed === 1
            ? "Chunks are cached at one speed, so every rate here plays the same audio."
            : `This device plays at most ${DEFAULT_SINK_MAX_RATE}×, so audio is synthesized at ${plan.synthSpeed}× and played at ${plan.sinkRate}×.`}
        </Text>
      </View>
    </Modal>
  );
}

/** The sheet's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    backdrop: { backgroundColor: theme.colors.ink, bottom: 0, left: 0, opacity: 0.35, position: "absolute", right: 0, top: 0 },
    sheet: {
      backgroundColor: theme.colors.surface,
      borderTopColor: theme.colors.line,
      borderTopLeftRadius: radius.three,
      borderTopRightRadius: radius.three,
      borderTopWidth: 1,
      bottom: 0,
      gap: theme.spacing.three,
      left: 0,
      padding: theme.spacing.four,
      position: "absolute",
      right: 0,
    },
    heading: { color: theme.colors.ink, fontSize: theme.type.label, fontFamily: theme.fontFamily.sansEmphasis },
    stepper: { alignItems: "center", flexDirection: "row", gap: theme.spacing.four, justifyContent: "center" },
    step: {
      alignItems: "center",
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      height: theme.control.size,
      justifyContent: "center",
      width: theme.control.size,
    },
    stepOff: { opacity: 0.4 },
    stepText: { color: theme.colors.ink, fontSize: theme.type.body },
    value: { color: theme.colors.ink, fontSize: theme.type.body + 6, fontVariant: ["tabular-nums"] },
    presets: { gap: theme.spacing.two },
    chip: {
      alignItems: "center",
      backgroundColor: theme.colors.paper,
      borderColor: theme.colors.line,
      borderRadius: radius.three,
      borderWidth: 1,
      justifyContent: "center",
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.four,
    },
    chipOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.ink, fontSize: theme.type.label },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
  });
}
