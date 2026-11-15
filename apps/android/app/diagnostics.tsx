/**
 * The diagnostics screen (F§10.4).
 *
 * It runs whatever the registry holds — this unit registers the core goldens and the hub's health — and draws
 * one row per check whose text is `PASS <id>` or `FAIL <id>`, so the on-device verification a later unit runs
 * through `adb` has a stable string to look for. `?autorun=1` starts the run as the screen opens, which is what
 * makes `adb shell am start -a android.intent.action.VIEW -d "lectern://diagnostics?autorun=1"` a one-shot
 * verification.
 *
 * Checks run in registration order, one at a time: the hub's own check can wait on a network timeout, and a
 * reader watching the list should see the rows fill in as they finish.
 */

import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { checks, type DiagnosticResult } from "../src/diagnostics/checks";
import { radius, type Theme, useTheme } from "../src/theme";

/** A row's state: not started, running (present in the map as `null`), or finished. */
type RowState = DiagnosticResult | null;

export default function DiagnosticsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const params = useLocalSearchParams<{ autorun?: string }>();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);

  const runAll = useCallback(async () => {
    setRunning(true);
    setRows({});
    for (const check of checks) {
      setRows((previous) => ({ ...previous, [check.id]: null }));
      const result = await check.run();
      setRows((previous) => ({ ...previous, [check.id]: result }));
    }
    setRunning(false);
  }, []);

  useEffect(() => {
    if (params.autorun === "1") void runAll();
  }, [params.autorun, runAll]);

  /** What a row says: the id until it has run, then the contract's `PASS <id>` / `FAIL <id>`. */
  function rowText(id: string): string {
    if (!Object.hasOwn(rows, id)) return `${id} — waiting`;
    const result = rows[id];
    if (result === undefined || result === null) return `${id} — running`;
    return `${result.ok ? "PASS" : "FAIL"} ${id}`;
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Pressable style={styles.button} onPress={() => void runAll()} disabled={running} accessibilityRole="button" testID="run-checks">
        <Text style={styles.buttonText}>{running ? "Running…" : "Run checks"}</Text>
      </Pressable>

      {checks.map((check) => (
        <View key={check.id} style={styles.row} testID={check.id}>
          <Text style={styles.rowTitle}>{check.title}</Text>
          <Text style={styles.rowText} testID={`${check.id}-result`}>
            {rowText(check.id)}
          </Text>
          {rows[check.id] === null || rows[check.id] === undefined ? null : <Text style={styles.detail}>{rows[check.id]?.detail}</Text>}
        </View>
      ))}
    </ScrollView>
  );
}

/** The screen's styles, built from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper },
    content: { padding: theme.spacing.four, gap: theme.spacing.two },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
    },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    row: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      padding: theme.spacing.three,
      gap: theme.spacing.one,
    },
    rowTitle: { color: theme.colors.ink, fontSize: theme.type.label, fontWeight: "600" },
    rowText: { color: theme.colors.ink, fontFamily: theme.fontFamily.mono, fontSize: theme.type.caption },
    detail: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
  });
}
