/**
 * The sync card (F§8, F§10.4): this device's switch, what the engine is doing, and the two numbers a reader
 * can act on.
 *
 * It is a view of U-061's service and nothing more. The switch is F§8's own enable/disable — off stops the
 * engine, so nothing is pushed, pulled or attempted — and the three lines under it are F§8.2's own figures:
 * the state, how many ops the outbox is holding, and when the last round that reached the hub finished.
 * "Sync now" asks for a round and waits for it, which is what a reader wants after editing on another device.
 *
 * Nothing here is a requirement of anything else in the app: a device with no hub, or with the switch off,
 * draws the same card and reads its library, its documents and its audio exactly as it does without it.
 */

import type { SyncStatus } from "@lectern/api-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { radius, type Theme, useTheme } from "../theme";
import { type SyncService, type SyncView, syncService } from "./sync-service";

/** F§8.2's four states as a reader reads them. */
const STATE_LABELS: Readonly<Record<SyncStatus["state"], string>> = {
  idle: "Up to date",
  syncing: "Syncing",
  offline: "No hub in front of you",
  error: "The hub refused the last round",
};

/** A timestamp as the clock the reader is in front of, or a sentence when there has not been one yet. */
function lastSyncedLabel(at: number | null): string {
  if (at === null) return "not yet";
  return new Date(at).toLocaleTimeString();
}

/** A failure as the sentence a reader can act on. */
function problemOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface SyncCardProps {
  /** The service to read. The app's own by default; a fake in a test. */
  service?: SyncService;
}

export function SyncCard({ service = syncService }: SyncCardProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [view, setView] = useState<SyncView>(() => service.view());
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const unsubscribe = service.subscribe(setView);
    // The switch is stored outside the service's own status, so it is read once and again after every write.
    void service
      .enabled()
      .then((value) => {
        if (live) setEnabled(value);
      })
      .catch(() => {
        if (live) setEnabled(null);
      });
    // A card that has just been drawn has no reading yet: the engine's own figures are asked for, and the
    // outbox depth comes back with them (F§8.2).
    void service
      .status()
      .then((status) => {
        if (live) setView({ running: service.running(), status });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service]);

  const flip = useCallback(
    async (value: boolean): Promise<void> => {
      setEnabled(value);
      setBusy(true);
      setProblem(null);
      try {
        await service.setEnabled(value);
      } catch (cause) {
        setProblem(problemOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [service],
  );

  const syncNow = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await service.syncNow();
      setView({ running: service.running(), status: await service.status() });
    } catch (cause) {
      setProblem(problemOf(cause));
    } finally {
      setBusy(false);
    }
  }, [service]);

  const status = view.status;

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Switch
          value={enabled ?? true}
          onValueChange={(value) => void flip(value)}
          trackColor={{ true: theme.colors.accentSoft }}
          disabled={busy || enabled === null}
          testID="sync-enabled"
        />
        <Text style={styles.label}>Sync this device with the hub</Text>
      </View>

      <Text style={styles.status} testID="sync-status">
        {`${STATE_LABELS[status.state]} · ${status.pending} waiting · last synced ${lastSyncedLabel(status.lastSyncedAt)}`}
      </Text>

      <Pressable
        style={styles.button}
        onPress={() => void syncNow()}
        disabled={busy || !view.running}
        accessibilityRole="button"
        testID="sync-now"
      >
        {busy ? <ActivityIndicator color={theme.colors.accentInk} /> : <Text style={styles.buttonText}>Sync now</Text>}
      </Pressable>

      {problem === null ? null : <Text style={styles.problem}>{problem}</Text>}
    </View>
  );
}

/** The card's styles, built from the theme's tokens so every colour and measurement is the shared one. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.two,
      padding: theme.spacing.three,
    },
    row: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two },
    label: { color: theme.colors.ink, flexShrink: 1, fontSize: theme.type.label },
    status: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
    },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    problem: { color: theme.colors.danger, fontSize: theme.type.caption },
  });
}
