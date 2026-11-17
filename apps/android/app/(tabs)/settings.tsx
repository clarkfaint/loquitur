/**
 * The settings tab (F§10.4, F§11).
 *
 * Two things live here: the hub connection — the address and F§11's one bearer token, saved to the platform's
 * secure store and proved with a button that asks the hub for its health and for its voice list, because
 * `/healthz` answers without a token (F§7.2) and a wrong token would otherwise read as a healthy hub — and
 * the reader's playback preferences.
 *
 * The preferences are the controls F§5.4, F§5.6(d) and F§5.6(e) define: the speed, the voice, whether skipped
 * furniture and citation markers are read, and how far ahead of the sink the highlight is drawn. They are held
 * in this screen's own state for now; F§5.9's store — one `setting` record per field, so one device's speed
 * cannot overwrite another's — arrives with `apps/android/src/stores`, and a second place to keep them before
 * that would be a second thing to migrate.
 *
 * The tab's own title and mark are the group layout's (`(tabs)/_layout.tsx`, over `src/tabs/marks`), not this
 * file's: a tab navigator draws every label and mark, not only this screen's, so the layout is the one place
 * that can name them all.
 */

import { clampRate, RATE_MAX, RATE_MIN, RATE_PRESETS, RATE_STEP } from "@lectern/core";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { type Connection, createClient, getConnection, onConnectionChanged, setConnection } from "../../src/connection";
import { SyncCard } from "../../src/sync/SyncCard";
import { radius, type Theme, useTheme } from "../../src/theme";

/** One rate, snapped onto F§5.6(e)'s 0.05 step and held inside its range. */
function snapRate(value: number): number {
  return clampRate(Number(value.toFixed(2)));
}

export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [stored, setStored] = useState<Connection | null>(null);
  const [hubUrl, setHubUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);

  const [rate, setRate] = useState(1);
  const [voiceId, setVoiceId] = useState("");
  const [skipFurniture, setSkipFurniture] = useState(true);
  const [skipCitations, setSkipCitations] = useState(true);
  const [lookaheadMs, setLookaheadMs] = useState(80);

  useEffect(() => {
    let mounted = true;
    void getConnection().then((connection) => {
      if (!mounted) return;
      setStored(connection);
      setHubUrl(connection?.hubUrl ?? "");
      setToken(connection?.token ?? "");
    });
    const unsubscribe = onConnectionChanged((connection) => {
      if (mounted) setStored(connection);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  /** Save what the form holds, then ask the hub to prove it: the probe and one authenticated route. */
  async function testConnection() {
    setBusy(true);
    setProbe(null);
    try {
      await setConnection({ hubUrl, token });
      const client = await createClient();
      const health = await client.health();
      const voices = await client.voices();
      const engines = health.engines.length > 0 ? health.engines.join(", ") : "no engines";
      setProbe(`Answered: version ${health.version}, engines ${engines}, ${voices.length} voices.`);
    } catch (cause) {
      setProbe(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Hub</Text>
      <Text style={styles.hint}>{stored === null ? "No hub is configured yet." : `Saved: ${stored.hubUrl}`}</Text>

      <Text style={styles.label}>Hub address</Text>
      <TextInput
        style={styles.input}
        value={hubUrl}
        onChangeText={setHubUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://192.168.1.10:8787"
        placeholderTextColor={theme.colors.inkMuted}
        testID="hub-url"
      />

      <Text style={styles.label}>Token</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="the token the hub was started with"
        placeholderTextColor={theme.colors.inkMuted}
        testID="hub-token"
      />

      <Pressable
        style={styles.button}
        onPress={() => void testConnection()}
        disabled={busy}
        accessibilityRole="button"
        testID="test-connection"
      >
        {busy ? <ActivityIndicator color={theme.colors.accentInk} /> : <Text style={styles.buttonText}>Test connection</Text>}
      </Pressable>
      {probe === null ? null : <Text style={styles.probe}>{probe}</Text>}

      <Text style={styles.heading}>Sync</Text>
      <SyncCard />

      <Text style={styles.heading}>Playback</Text>

      <Text style={styles.label}>Speed</Text>
      <View style={styles.row}>
        <Pressable
          style={styles.step}
          onPress={() => setRate((current) => snapRate(current - RATE_STEP))}
          accessibilityRole="button"
          testID="rate-slower"
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.rateValue} testID="rate-value">
          {`${rate.toFixed(2)}×`}
        </Text>
        <Pressable
          style={styles.step}
          onPress={() => setRate((current) => snapRate(current + RATE_STEP))}
          accessibilityRole="button"
          testID="rate-faster"
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>{`${RATE_MIN.toFixed(2)}× to ${RATE_MAX.toFixed(2)}×, in steps of ${RATE_STEP.toFixed(2)}.`}</Text>
      <View style={styles.row}>
        {RATE_PRESETS.map((preset) => (
          <Pressable
            key={preset}
            style={[styles.chip, preset === rate ? styles.chipActive : null]}
            onPress={() => setRate(snapRate(preset))}
            accessibilityRole="button"
            testID={`rate-${preset}`}
          >
            <Text style={preset === rate ? styles.chipTextActive : styles.chipText}>{`${preset}×`}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Voice</Text>
      <TextInput
        style={styles.input}
        value={voiceId}
        onChangeText={setVoiceId}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="kokoro:af_alloy"
        placeholderTextColor={theme.colors.inkMuted}
        testID="voice-id"
      />
      <Text style={styles.hint}>An `engine:voice` id, as the hub lists it.</Text>

      <View style={styles.row}>
        <Switch
          value={skipFurniture}
          onValueChange={setSkipFurniture}
          trackColor={{ true: theme.colors.accentSoft }}
          testID="skip-furniture"
        />
        <Text style={styles.switchLabel}>Skip headers, footers and footnotes</Text>
      </View>
      <View style={styles.row}>
        <Switch
          value={skipCitations}
          onValueChange={setSkipCitations}
          trackColor={{ true: theme.colors.accentSoft }}
          testID="skip-citations"
        />
        <Text style={styles.switchLabel}>Skip citation markers</Text>
      </View>
      <View style={styles.row}>
        <Switch
          value={lookaheadMs > 0}
          onValueChange={(on) => setLookaheadMs(on ? 80 : 0)}
          trackColor={{ true: theme.colors.accentSoft }}
          testID="lookahead"
        />
        <Text style={styles.switchLabel}>{`Highlight ${lookaheadMs} ms ahead of the audio`}</Text>
      </View>

      <Text style={styles.heading}>Diagnostics</Text>
      <Link href="/diagnostics" asChild>
        <Pressable style={styles.link} accessibilityRole="button" testID="open-diagnostics">
          <Text style={styles.linkText}>Run the device checks</Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}

/** The screen's styles, built from the theme's tokens so every colour and measurement is the shared one. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper },
    content: { padding: theme.spacing.four, paddingBottom: theme.spacing.five, gap: theme.spacing.two },
    heading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600", marginTop: theme.spacing.three },
    label: { color: theme.colors.ink, fontSize: theme.type.label, marginTop: theme.spacing.two },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    input: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      color: theme.colors.ink,
      fontSize: theme.type.label,
      paddingHorizontal: theme.spacing.three,
      paddingVertical: theme.spacing.two,
    },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
      marginTop: theme.spacing.two,
    },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    probe: { color: theme.colors.ink, fontSize: theme.type.caption },
    row: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two, marginTop: theme.spacing.one },
    step: {
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      height: theme.control.size,
      justifyContent: "center",
      width: theme.control.size,
    },
    stepText: { color: theme.colors.ink, fontSize: theme.type.body },
    rateValue: { color: theme.colors.ink, fontSize: theme.type.body, minWidth: 72, textAlign: "center" },
    chip: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.one,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.three,
      paddingVertical: theme.spacing.one,
    },
    chipActive: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.ink, fontSize: theme.type.caption },
    chipTextActive: { color: theme.colors.ink, fontSize: theme.type.caption, fontWeight: "600" },
    switchLabel: { color: theme.colors.ink, flexShrink: 1, fontSize: theme.type.label },
    link: {
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      height: theme.control.size,
      justifyContent: "center",
    },
    linkText: { color: theme.colors.accent, fontSize: theme.type.label, fontWeight: "600" },
  });
}
