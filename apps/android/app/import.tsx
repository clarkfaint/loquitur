/**
 * The import screen (F§10.4, F§7.2).
 *
 * Three ways in, all of them the reader's own: choose a file with the system picker, paste whatever the
 * clipboard holds, or type text into the box. The first is a hub reading of the file's bytes, the second is
 * whichever of the two roads the pasted string belongs on (an address, or text), and the third is always the
 * device's own reading — F§10.4 builds plain text locally with `buildDocument`, so typed and pasted text works
 * with the hub unreachable.
 *
 * Every import gets its own row under the buttons, and the row is the whole of this screen's state: it shows a
 * spinner while the work is in flight, the answer when it lands, the reason when it fails, and a Cancel while
 * it is still running. Nothing here blocks the reader: each import is an ordinary promise in a handler, so the
 * buttons stay live and a second file can be started while the first is still being read.
 *
 * Cancelling is honest rather than magical. The hub client takes a base URL, a token and a `fetch` and exposes
 * no abort signal, and `POST /v1/parse` has no cancel route, so a request that is already running cannot be
 * stopped from here: the row is dropped and the screen says plainly that the hub may still finish the import.
 */

import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { classifyPastedInput } from "../src/import/classify-input";
import { type ImportResult, importPickedFile, importTextLocal, importUrl, SUPPORTED_IMPORT_MIME_TYPES } from "../src/import/import-service";
import { radius, type Theme, useTheme } from "../src/theme";

/** What one import is doing, from the reader's side. */
type ImportState = "working" | "done" | "duplicate" | "failed";

/** One import this session has run: what it was, how it went, and which document it became. */
interface ImportItem {
  id: string;
  label: string;
  state: ImportState;
  /** The failure's own sentence, or `null` while there is nothing to report. */
  message: string | null;
  /** The document the import produced, once the library has it. */
  docId: string | null;
}

/** A failure as the sentence a reader can act on. */
function problemOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A short label for a block of pasted or typed text: its first line, cut to fit a row. */
function labelForText(text: string): string {
  const firstLine = text.trim().split("\n", 1).join("").trim();
  const label = firstLine === "" ? "Pasted text" : firstLine;
  return label.length > 48 ? `${label.slice(0, 47)}…` : label;
}

/** What a row says about its own state. */
function stateText(item: ImportItem): string {
  if (item.state === "working") return "Importing…";
  if (item.state === "done") return "Added to the library.";
  if (item.state === "duplicate") return "The library already holds this document.";
  return "Could not import this.";
}

export default function ImportScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [items, setItems] = useState<ImportItem[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const counter = useRef(0);

  /**
   * Run one import and give it a row. The row is added before the work starts, so a slow hub shows progress
   * rather than nothing; its answer is written into that row and nowhere else, which is also what makes a
   * cancelled row's late answer harmless — the row it names is no longer in the list.
   */
  const run = useCallback(async (label: string, work: () => Promise<ImportResult>): Promise<void> => {
    counter.current += 1;
    const id = `import-${counter.current}`;
    setItems((current): ImportItem[] => [{ id, label, state: "working", message: null, docId: null }, ...current]);
    try {
      const result = await work();
      setItems((current): ImportItem[] =>
        current.map((item) => (item.id === id ? { ...item, state: result.duplicate ? "duplicate" : "done", docId: result.docId } : item)),
      );
    } catch (cause) {
      setItems((current): ImportItem[] =>
        current.map((item) => (item.id === id ? { ...item, state: "failed", message: problemOf(cause) } : item)),
      );
    }
  }, []);

  /** Drop a row the reader no longer wants to wait for, and say what that does and does not do. */
  const cancel = useCallback((id: string): void => {
    setItems((current) => current.filter((item) => item.id !== id));
    setNote("Cancelled. The hub may still finish that import — if it does, the document will appear in the library.");
  }, []);

  /** Choose a file with the system picker, limited to the formats the hub reads as documents. */
  const chooseFile = useCallback(async (): Promise<void> => {
    setNote(null);
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({ type: [...SUPPORTED_IMPORT_MIME_TYPES] });
    } catch (cause) {
      setNote(problemOf(cause));
      return;
    }
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (asset === undefined) return;
    const mime = asset.mimeType ?? "";
    await run(asset.name, () => importPickedFile({ uri: asset.uri, name: asset.name, mime }));
  }, [run]);

  /** Import whatever the clipboard holds, down the road the pasted string belongs on. */
  const paste = useCallback(async (): Promise<void> => {
    setNote(null);
    let clip: string;
    try {
      clip = await Clipboard.getStringAsync();
    } catch (cause) {
      setNote(problemOf(cause));
      return;
    }
    const input = classifyPastedInput(clip);
    if (input.kind === "url") {
      await run(input.url, () => importUrl(input.url));
      return;
    }
    if (input.text === "") {
      setNote("The clipboard holds nothing to import.");
      return;
    }
    await run(labelForText(input.text), () => importTextLocal(input.text));
  }, [run]);

  /** Import the text in the box, on the device: no hub, no network, nothing to wait for. */
  const importTypedText = useCallback(async (): Promise<void> => {
    if (text.trim() === "") {
      setNote("Type or paste some text into the box first.");
      return;
    }
    setNote(null);
    const body = text;
    setText("");
    await run(labelForText(body), () => importTextLocal(body));
  }, [run, text]);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: "Import" }} />

      <Text style={styles.heading}>Add to the library</Text>
      <Text style={styles.hint}>
        Files and links are read by the hub. Typed and pasted text is read on this device, so it works offline.
      </Text>

      <Pressable style={styles.button} onPress={() => void chooseFile()} accessibilityRole="button" testID="choose-file">
        <Text style={styles.buttonText}>Choose file</Text>
      </Pressable>

      <Pressable style={styles.secondary} onPress={() => void paste()} accessibilityRole="button" testID="paste-clipboard">
        <Text style={styles.secondaryText}>Paste</Text>
      </Pressable>

      <Text style={styles.label}>Text</Text>
      <TextInput
        style={styles.box}
        value={text}
        onChangeText={setText}
        multiline
        textAlignVertical="top"
        placeholder="Paste or type the text you want read aloud"
        placeholderTextColor={theme.colors.inkMuted}
        testID="import-text"
      />
      <Pressable style={styles.secondary} onPress={() => void importTypedText()} accessibilityRole="button" testID="import-text-button">
        <Text style={styles.secondaryText}>Import text</Text>
      </Pressable>

      {note === null ? null : <Text style={styles.note}>{note}</Text>}

      <Text style={styles.heading}>This session</Text>
      {items.length === 0 ? (
        <Text style={styles.hint} testID="no-imports">
          Nothing imported yet.
        </Text>
      ) : (
        items.map((item) => (
          <View key={item.id} style={styles.item} testID={`import-item-${item.state}`}>
            <View style={styles.itemHead}>
              <Text style={styles.itemLabel} numberOfLines={1}>
                {item.label}
              </Text>
              {item.state === "working" ? <ActivityIndicator color={theme.colors.accent} /> : null}
            </View>
            <Text style={styles.itemState}>{stateText(item)}</Text>
            {item.message === null ? null : <Text style={styles.itemError}>{item.message}</Text>}
            <View style={styles.itemActions}>
              {item.state === "working" ? (
                <Pressable style={styles.small} onPress={() => cancel(item.id)} accessibilityRole="button" testID="cancel-import">
                  <Text style={styles.smallText}>Cancel</Text>
                </Pressable>
              ) : null}
              {item.docId === null ? null : (
                <Pressable
                  style={styles.small}
                  onPress={() => router.push(`/read/${item.docId ?? ""}`)}
                  accessibilityRole="button"
                  testID="read-import"
                >
                  <Text style={styles.smallText}>Read</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

/** The screen's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper },
    content: { gap: theme.spacing.two, padding: theme.spacing.four, paddingBottom: theme.spacing.five },
    heading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600", marginTop: theme.spacing.three },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    label: { color: theme.colors.ink, fontSize: theme.type.label, marginTop: theme.spacing.two },
    button: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
      marginTop: theme.spacing.two,
    },
    buttonText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
    secondary: {
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      height: theme.control.size,
      justifyContent: "center",
    },
    secondaryText: { color: theme.colors.ink, fontSize: theme.type.label, fontWeight: "600" },
    box: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      color: theme.colors.ink,
      fontSize: theme.type.label,
      minHeight: 120,
      padding: theme.spacing.three,
    },
    note: { color: theme.colors.ink, fontSize: theme.type.caption, marginTop: theme.spacing.two },
    item: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.one,
      padding: theme.spacing.three,
    },
    itemHead: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two, justifyContent: "space-between" },
    itemLabel: { color: theme.colors.ink, flexShrink: 1, fontSize: theme.type.label, fontWeight: "600" },
    itemState: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    itemError: { color: theme.colors.danger, fontSize: theme.type.caption },
    itemActions: { flexDirection: "row", gap: theme.spacing.two },
    small: {
      borderColor: theme.colors.line,
      borderRadius: radius.one,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.three,
      paddingVertical: theme.spacing.one,
    },
    smallText: { color: theme.colors.ink, fontSize: theme.type.caption },
  });
}
