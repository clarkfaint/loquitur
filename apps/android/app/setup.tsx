/**
 * The `lectern://setup` deep link (F§10.4).
 *
 * The link carries the hub's address and F§11's token, which is how a reader moves a connection from a
 * terminal or a chat message into the app without typing a token on a phone keyboard. Nothing is saved while
 * the screen is open: it shows what the link asked for, and the connection is written only when the reader
 * presses Connect. A link with no usable address says so instead of offering a button that cannot work, and
 * the token itself is never printed — only whether one arrived.
 */

import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { normalizeHubUrl, setConnection } from "../src/connection";
import { radius, type Theme, useTheme } from "../src/theme";

/** One parameter of a deep link, which arrives as a string (or an array when the link repeats it). */
function parameterOf(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

export default function SetupScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ hubUrl?: string; token?: string }>();

  const hubUrl = parameterOf(params.hubUrl);
  const token = parameterOf(params.token);
  const normalized = normalizeHubUrl(hubUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usable = normalized !== null && token !== "";

  async function connect() {
    if (normalized === null || token === "") return;
    setBusy(true);
    setError(null);
    try {
      await setConnection({ hubUrl: normalized, token });
      router.replace("/settings");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Connect to a hub</Text>
      <Text style={styles.label}>Hub address</Text>
      <Text style={styles.value}>
        {normalized ?? (hubUrl === "" ? "the link carried no hub address" : `not a usable address: ${hubUrl}`)}
      </Text>
      <Text style={styles.label}>Token</Text>
      <Text style={styles.value}>{token === "" ? "the link carried no token" : "a token arrived with the link"}</Text>
      <Text style={styles.hint}>Nothing is saved until you press Connect.</Text>

      <Pressable
        style={usable ? styles.button : styles.buttonDisabled}
        onPress={() => void connect()}
        disabled={!usable || busy}
        accessibilityRole="button"
        testID="connect"
      >
        <Text style={styles.buttonText}>Connect</Text>
      </Pressable>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

/** The screen's styles, built from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper },
    content: { padding: theme.spacing.four, gap: theme.spacing.two },
    heading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600" },
    label: { color: theme.colors.inkMuted, fontSize: theme.type.caption, marginTop: theme.spacing.two },
    value: { color: theme.colors.ink, fontSize: theme.type.label },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption, marginTop: theme.spacing.two },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
      marginTop: theme.spacing.three,
    },
    buttonDisabled: { backgroundColor: theme.colors.line },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    error: { color: theme.colors.danger, fontSize: theme.type.caption },
  });
}
