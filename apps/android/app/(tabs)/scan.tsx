/**
 * The scan tab (F§10.4, F§5.5).
 *
 * F§10.4's camera path, from the reader's side: take the pages of a document, watch them being read, and save
 * the lot as one library entry. The screen owns only what the reader can see — the pages taken, how far the
 * reading has got, the text that has come back so far — and hands every decision to `src/scan`, so the work
 * that needs a device (the scanner, the camera, the recogniser) stays in one place and the screen stays a
 * screen.
 *
 * **Pages are read one at a time, as they arrive.** The recogniser is asked for one page and the answer is
 * appended, which is what makes the progress line honest ("Reading page 3 of 5") and what fills the preview in
 * while the reader waits. It also means a page that reads nothing costs nothing: an empty page is an empty
 * list, and the pages around it are unaffected.
 *
 * **Nothing is imported until the reader says so.** A scan is only a document when "Save and listen" is
 * pressed, so a reader who photographs the wrong page, or closes the screen, leaves no library entry and no
 * page images behind — "Discard" deletes them, and so does a save.
 *
 * **A scan that read nothing says so.** If every page came back blank the reader is told, in the words of what
 * to do about it, rather than being handed an empty document; `saveScan` refuses it for the same reason.
 */

import type { RawBlock } from "@lectern/core";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { discardScanImages, recognizePages, saveScan, scanPages } from "../../src/scan/scan-service";
import { radius, type Theme, useTheme } from "../../src/theme";

/** How much of the recognised text the preview shows before it stops. */
const PREVIEW_LENGTH = 280;

/** What the screen is doing: nothing, taking pages, reading them, or storing the document. */
type Stage = "idle" | "scanning" | "reading" | "saving";

/** The text of every block of every page, in reading order, as one string. */
function textOf(pages: readonly RawBlock[][]): string {
  const parts: string[] = [];
  for (const page of pages) {
    for (const block of page) parts.push(block.text);
  }
  return parts.join("\n");
}

/** The preview a reader checks the scan against: the beginning of what was read, and whether it is cut. */
function previewOf(pages: readonly RawBlock[][]): string {
  const text = textOf(pages).trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
}

/** A failure as the sentence a reader can act on. */
function problemOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The screen's styles, from the theme's tokens. */
type ScreenStyles = ReturnType<typeof createStyles>;

/** One button: the screen has four, and they differ only in their label, their weight and what they run. */
function Button({
  label,
  onPress,
  styles,
  variant,
  testID,
  disabled,
}: {
  label: string;
  onPress: () => void;
  styles: ScreenStyles;
  variant: "primary" | "secondary";
  testID: string;
  disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={variant === "primary" ? styles.button : styles.secondary}
      testID={testID}
    >
      <Text style={variant === "primary" ? styles.buttonText : styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export default function ScanScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [stage, setStage] = useState<Stage>("idle");
  const [uris, setUris] = useState<string[]>([]);
  const [pages, setPages] = useState<RawBlock[][]>([]);
  const [reading, setReading] = useState({ done: 0, total: 0 });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which run owns the screen's state; a run that has been superseded never writes to it again. */
  const run = useRef(0);

  /** Take a batch of pages and read them, appending to whatever the screen already holds. */
  const takePages = useCallback(async (): Promise<void> => {
    const id = run.current + 1;
    run.current = id;
    setError(null);
    setNote(null);
    setStage("scanning");
    try {
      const fresh = await scanPages();
      if (run.current !== id) return;
      if (fresh.length === 0) {
        setStage("idle");
        return;
      }
      setUris((current) => [...current, ...fresh]);
      setStage("reading");
      setReading({ done: 0, total: fresh.length });
      for (const [index, uri] of fresh.entries()) {
        const [blocks] = await recognizePages([uri]);
        if (run.current !== id) return;
        setPages((current) => [...current, blocks]);
        setReading({ done: index + 1, total: fresh.length });
      }
      if (run.current !== id) return;
      setStage("idle");
    } catch (cause) {
      if (run.current !== id) return;
      setError(problemOf(cause));
      setStage("idle");
    }
  }, []);

  /** Store the pages as one document and open it, or say why there is nothing to store. */
  const save = useCallback(async (): Promise<void> => {
    const id = run.current + 1;
    run.current = id;
    setError(null);
    setStage("saving");
    try {
      const saved = await saveScan(pages, uris);
      if (run.current !== id) return;
      setStage("idle");
      if (saved === null) {
        setUris([]);
        setPages([]);
        setNote("No text was found in these pages. Hold the camera steady, keep the page flat, and try again.");
        return;
      }
      setUris([]);
      setPages([]);
      router.replace(`/read/${saved.docId}`);
    } catch (cause) {
      if (run.current !== id) return;
      setError(problemOf(cause));
      setStage("idle");
    }
  }, [pages, router, uris]);

  /** Throw the pages away, images and all. */
  const discard = useCallback(async (): Promise<void> => {
    const id = run.current + 1;
    run.current = id;
    setError(null);
    setNote(null);
    const taken = uris;
    setUris([]);
    setPages([]);
    setReading({ done: 0, total: 0 });
    await discardScanImages(taken);
  }, [uris]);

  const busy = stage !== "idle";
  const pageCount = uris.length;
  const preview = previewOf(pages);
  const readNothing = pageCount > 0 && textOf(pages).trim() === "";

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Scan a document</Text>
      <Text style={styles.hint}>
        Photograph the pages in order. Loquitur reads them on this phone — nothing is uploaded, and no photograph is kept once the document
        is saved.
      </Text>

      {busy ? (
        <View style={styles.status} testID="scan-busy">
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>
            {stage === "scanning" ? "Waiting for the camera…" : null}
            {stage === "reading" ? `Reading page ${Math.min(reading.done + 1, reading.total)} of ${reading.total}…` : null}
            {stage === "saving" ? "Saving the document…" : null}
          </Text>
        </View>
      ) : null}

      {error === null ? null : (
        <Text style={styles.error} testID="scan-error">
          {error}
        </Text>
      )}

      {note === null ? null : (
        <Text style={styles.note} testID="scan-note">
          {note}
        </Text>
      )}

      <View style={styles.card} testID="scan-summary">
        <Text style={styles.label}>{pageCount === 1 ? "1 page" : `${pageCount} pages`}</Text>
        <Text style={styles.value} testID="scan-page-count">
          {pageCount === 0
            ? "No pages yet."
            : `${pageCount} photographed, ${reading.done === reading.total ? pageCount : reading.done} read.`}
        </Text>
        {preview === "" ? null : (
          <Text style={styles.preview} testID="scan-preview">
            {preview}
          </Text>
        )}
      </View>

      {readNothing && !busy ? (
        <Text style={styles.note} testID="scan-empty">
          No text was found in these pages. Hold the camera steady, keep the page flat, and try again.
        </Text>
      ) : null}

      <Button
        disabled={busy}
        label={pageCount === 0 ? "Start scan" : "Add pages"}
        onPress={() => void takePages()}
        styles={styles}
        testID={pageCount === 0 ? "start-scan" : "add-pages"}
        variant="primary"
      />

      {pageCount === 0 ? null : (
        <>
          <Button
            disabled={busy || readNothing}
            label="Save and listen"
            onPress={() => void save()}
            styles={styles}
            testID="save-scan"
            variant="secondary"
          />
          <Button
            disabled={busy}
            label="Discard"
            onPress={() => void discard()}
            styles={styles}
            testID="discard-scan"
            variant="secondary"
          />
        </>
      )}
    </ScrollView>
  );
}

function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper },
    content: { gap: theme.spacing.two, padding: theme.spacing.four, paddingBottom: theme.spacing.five },
    heading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600", marginTop: theme.spacing.three },
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption, lineHeight: theme.type.caption * 1.5 },
    label: { color: theme.colors.inkMuted, fontSize: theme.type.caption, textTransform: "uppercase" },
    value: { color: theme.colors.ink, fontSize: theme.type.label },
    preview: { color: theme.colors.ink, fontSize: theme.type.label, lineHeight: theme.type.label * 1.5 },
    note: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    error: { color: theme.colors.danger, fontSize: theme.type.caption },
    status: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two },
    card: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.one,
      marginTop: theme.spacing.two,
      padding: theme.spacing.three,
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
  });
}
