/**
 * The reader screen (F§10.4).
 *
 * One route per document: `/read/<docId>`, with `?autoplay=1` asking playback to start as soon as the document
 * is loaded — which is how the desktop shell and the share flow hand a document over to a phone. The screen
 * itself owns no playback state at all: `PlayerProvider` builds the player for this document, and everything
 * drawn here comes from the snapshot, the model and the two numbers of F§5.6(f).
 *
 * The screen shows one of four things, and never a blank page: the document with its transport, a spinner while
 * the document is still coming out of the store, a not-found state when the library holds no such document, and
 * — beside any of them — the sentence saying why nothing can be read yet, which is a hub that is not configured
 * or a voice list that could not be listed.
 *
 * The list and the bar are siblings rather than an overlay: the text is what the reader came for, so the
 * transport takes its own strip at the bottom instead of covering the last lines of the page.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { PlayerProvider, usePlayer } from "../../src/player/player-context";
import { useActiveWord } from "../../src/player/use-active-word";
import { BlockList } from "../../src/reader/BlockList";
import { PlayerBarNative } from "../../src/reader/PlayerBarNative";
import { SpeedSheet } from "../../src/reader/SpeedSheet";
import { VoiceSheet } from "../../src/reader/VoiceSheet";
import { type Theme, useTheme } from "../../src/theme";

/** The reader itself, inside the provider that owns this document's player. */
function Reader() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const player = usePlayer();
  const [speedOpen, setSpeedOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);

  // F§5.6(d)'s clock: at most every 50 ms while audio moves, once per change otherwise.
  const active = useActiveWord(player.controller, player.snapshot.state);

  const dispatch = player.dispatch;
  const seek = useCallback((sentenceIndex: number) => dispatch({ type: "seek", sentenceIndex }), [dispatch]);
  const model = player.model;
  const selected = player.voices.find((voice) => voice.id === player.snapshot.voiceId);

  if (player.notFound) {
    return (
      <View style={[styles.page, styles.centred]}>
        <Stack.Screen options={{ title: "Not found" }} />
        <Text style={styles.heading}>This document is not in the library</Text>
        <Text style={styles.hint}>It may have been deleted, or the link may name a document from another device.</Text>
        <Pressable style={styles.button} onPress={() => router.back()} accessibilityRole="button" testID="leave-reader">
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (model === null) {
    return (
      <View style={[styles.page, styles.centred]}>
        <Stack.Screen options={{ title: "Reading" }} />
        <ActivityIndicator color={theme.colors.accent} />
        {player.problem === null ? null : <Text style={styles.problem}>{player.problem}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: model.title }} />
      {player.problem === null ? null : <Text style={styles.problem}>{player.problem}</Text>}
      <View style={styles.tools}>
        <Pressable
          style={styles.summarise}
          onPress={() => router.push(`/summary/${model.docId}`)}
          accessibilityRole="button"
          testID="open-summary"
        >
          <Text style={styles.summariseText}>Summarize</Text>
        </Pressable>
      </View>
      <BlockList document={model} active={active} onSeek={seek} />
      <PlayerBarNative
        snapshot={player.snapshot}
        progress={player.progress}
        voiceLabel={selected?.name ?? ""}
        onCommand={dispatch}
        onOpenSpeed={() => setSpeedOpen(true)}
        onOpenVoice={() => setVoiceOpen(true)}
      />
      <SpeedSheet
        visible={speedOpen}
        rate={player.snapshot.rate}
        onSelect={(rate) => dispatch({ type: "setRate", rate })}
        onClose={() => setSpeedOpen(false)}
      />
      <VoiceSheet
        visible={voiceOpen}
        voices={player.voices}
        selectedId={player.snapshot.voiceId}
        onSelect={(voiceId) => {
          dispatch({ type: "setVoice", voiceId });
          setVoiceOpen(false);
        }}
        onClose={() => setVoiceOpen(false)}
      />
    </View>
  );
}

/** One parameter of a deep link, which arrives as a string (or an array when the link repeats it). */
function parameterOf(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

export default function ReadScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const params = useLocalSearchParams<{ docId?: string; autoplay?: string }>();
  const docId = parameterOf(params.docId);

  if (docId === "") {
    return (
      <View style={[styles.page, styles.centred]}>
        <Stack.Screen options={{ title: "Reading" }} />
        <Text style={styles.heading}>This link names no document</Text>
        <Text style={styles.hint}>Open a document from the library, or use a link that carries its identifier.</Text>
      </View>
    );
  }

  return (
    <PlayerProvider docId={docId} autoplay={parameterOf(params.autoplay) === "1"}>
      <Reader />
    </PlayerProvider>
  );
}

/** The screen's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper, flex: 1 },
    centred: { alignItems: "center", gap: theme.spacing.two, justifyContent: "center", padding: theme.spacing.five },
    heading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600", textAlign: "center" },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.label, textAlign: "center" },
    problem: {
      backgroundColor: theme.colors.accentSoft,
      color: theme.colors.ink,
      fontSize: theme.type.caption,
      paddingHorizontal: theme.spacing.four,
      paddingVertical: theme.spacing.two,
    },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: theme.radius.two,
      height: theme.control.size,
      justifyContent: "center",
      paddingHorizontal: theme.spacing.five,
    },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    tools: { alignItems: "flex-end", paddingHorizontal: theme.spacing.four, paddingTop: theme.spacing.two },
    summarise: {
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: theme.radius.two,
      borderWidth: 1,
      justifyContent: "center",
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.four,
    },
    summariseText: { color: theme.colors.ink, fontSize: theme.type.label, fontWeight: "600" },
  });
}
