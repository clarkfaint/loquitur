/**
 * The voice control (F§6).
 *
 * F§6's voices arrive from the hub as one flat list, each one naming its engine, its language and its own
 * display name. A reader chooses by language far more often than by anything else — a document is in one
 * language and the useful voices are the ones that speak it — so the sheet groups by `lang` and puts a text
 * filter over the whole list for the times a reader knows the name they want.
 *
 * The grouping and the filter are one pure function, so what the sheet shows is decided in one place and a
 * voice that matches by name, language, engine or identifier is never hidden behind a group heading that the
 * filter would otherwise have dropped.
 */

import type { Voice } from "@lectern/core-tts";
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { radius, type Theme, useTheme } from "../theme";

/** One language's voices, as the sheet lists them. */
export interface VoiceGroup {
  lang: string;
  voices: Voice[];
}

/**
 * `groupVoices(voices, filter)` — F§6's voices, grouped by language and narrowed by a filter.
 *
 * A voice matches when the filter appears in its name, its language, its engine or its identifier, compared
 * case-insensitively; an empty filter matches everything. Groups come back in language order and the voices
 * inside one in name order, so the list does not move around between two openings.
 */
export function groupVoices(voices: readonly Voice[], filter: string): VoiceGroup[] {
  const needle = filter.trim().toLowerCase();
  const matching = voices.filter((voice) => {
    if (needle === "") return true;
    return [voice.name, voice.lang, voice.engine, voice.id].some((field) => field.toLowerCase().includes(needle));
  });

  const byLang = new Map<string, Voice[]>();
  for (const voice of matching) {
    const group = byLang.get(voice.lang);
    if (group === undefined) byLang.set(voice.lang, [voice]);
    else group.push(voice);
  }

  return [...byLang.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([lang, group]) => ({ lang, voices: [...group].sort((left, right) => left.name.localeCompare(right.name)) }));
}

export interface VoiceSheetProps {
  /** Whether the sheet is up. */
  visible: boolean;
  /** F§6's voices, as the hub listed them. */
  voices: readonly Voice[];
  /** The voice in force (F§5.7's snapshot), so the sheet can mark it. */
  selectedId: string | null;
  /** Choose a voice: the player is asked to `setVoice` (F§6). */
  onSelect(voiceId: string): void;
  /** Put the sheet away. */
  onClose(): void;
}

/** `VoiceSheet` — F§6's voices, by language, behind a text filter. */
export function VoiceSheet({ visible, voices, selectedId, onSelect, onClose }: VoiceSheetProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => groupVoices(voices, filter), [voices, filter]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the voice list" />
      <View style={styles.sheet}>
        <Text style={styles.heading}>Voice</Text>
        <TextInput
          style={styles.input}
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter voices"
          placeholderTextColor={theme.colors.inkMuted}
          autoCorrect={false}
          accessibilityLabel="Filter voices"
          testID="voice-filter"
        />

        {voices.length === 0 ? (
          <Text style={styles.hint}>The hub listed no voices. Check the engines in Settings.</Text>
        ) : groups.length === 0 ? (
          <Text style={styles.hint}>{`No voice matches “${filter.trim()}”.`}</Text>
        ) : (
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {groups.map((group) => (
              <View key={group.lang} style={styles.group}>
                <Text style={styles.lang}>{group.lang}</Text>
                {group.voices.map((voice) => (
                  <Pressable
                    key={voice.id}
                    style={[styles.row, voice.id === selectedId ? styles.rowOn : null]}
                    onPress={() => onSelect(voice.id)}
                    accessibilityRole="button"
                    testID={`voice-${voice.id}`}
                  >
                    <Text style={styles.name} numberOfLines={1}>
                      {voice.name}
                    </Text>
                    <Text style={styles.engine} numberOfLines={1}>
                      {voice.engine}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        )}
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
      gap: theme.spacing.two,
      left: 0,
      maxHeight: "75%",
      padding: theme.spacing.four,
      position: "absolute",
      right: 0,
    },
    heading: { color: theme.colors.ink, fontFamily: theme.fontFamily.sansEmphasis, fontSize: theme.type.label },
    input: {
      backgroundColor: theme.colors.paper,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      color: theme.colors.ink,
      fontSize: theme.type.body,
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.three,
    },
    list: { flexGrow: 0 },
    listContent: { gap: theme.spacing.three },
    group: { gap: theme.spacing.one },
    lang: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    row: {
      alignItems: "center",
      backgroundColor: theme.colors.paper,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      flexDirection: "row",
      gap: theme.spacing.two,
      justifyContent: "space-between",
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.three,
    },
    rowOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
    name: { color: theme.colors.ink, flexShrink: 1, fontSize: theme.type.label },
    engine: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
  });
}
