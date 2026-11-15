/**
 * The share handler (F§10.4).
 *
 * Android opens this screen when another app shares something with Lectern: `expo-sharing`'s config plugin
 * declares the share intent filters, the module rewrites the launch at `lectern://expo-sharing`, and
 * `app/+native-intent.ts` turns that address into this route. What arrived is read with the module's own
 * `useIncomingShare()` hook — the raw payloads first, then the resolved ones, which is why the screen holds a
 * spinner while it resolves: resolving a shared address makes a request of its own.
 *
 * Nothing is imported before the reader can see what is about to be imported. The plan is drawn one row per
 * action, each with the type of what it names; a share that is only text or only an address is imported as soon
 * as the list appears, because that is the contract's own allowance and there is no file to lose; anything with a
 * file or an image in it waits for the button. Items Lectern will not import are listed with the reason and never
 * reach the hub.
 *
 * **Images are read here, on the device.** A shared photograph goes through the scan tab's own path —
 * `recognizePages` for the text, `saveScan` for the document — so it is recognised by the phone's own ML Kit
 * engine and never reaches the hub, which is F§5.5's boundary for the camera path; the hub's OCR stays for the
 * files F§5.4 hands it. A share that carried no text at all is reported as such rather than as an empty
 * document, because there is nothing to store.
 *
 * `expo-sharing` keeps a copy of every shared file in this app's cache, and F§10.4 keeps no copies of shared files
 * after an import, so the payloads are cleared once the imports have finished reading them. The plan and the
 * results are this screen's own state rather than the hook's, so clearing does not take the list off the screen.
 */

import { Stack, useRouter } from "expo-router";
import { useIncomingShare } from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { type ImportResult, importPickedFile, importTextLocal, importUrl } from "../src/import/import-service";
import { recognizePages, saveScan } from "../src/scan/scan-service";
import { planShare, type ShareAction } from "../src/share/route-share";
import { radius, type Theme, useTheme } from "../src/theme";

/** How far a row has got. */
type RowState = "done" | "failed" | "skipped";

/** One planned action, numbered so the list has a key that is the list's own. */
interface PlannedAction {
  id: string;
  action: ShareAction;
}

/** One planned action and what became of it. */
interface ShareRow {
  id: string;
  action: ShareAction;
  state: RowState;
  /** The sentence to show under the label: a refusal's reason, or a failure's message. */
  note: string | null;
  /** The documents the action produced. */
  docIds: string[];
}

/** A failure as the sentence a reader can act on. */
function problemOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A short label for a row: what it will import, in the reader's terms. */
function labelFor(action: ShareAction): string {
  if (action.kind === "url") return action.url;
  if (action.kind === "file") return action.name;
  if (action.kind === "images") return action.uris.length === 1 ? "1 image" : `${action.uris.length} images`;
  if (action.kind === "unsupported") return "Not imported";
  const firstLine = action.text.split("\n", 1).join("").trim();
  const label = firstLine === "" ? "Shared text" : firstLine;
  return label.length > 64 ? `${label.slice(0, 63)}…` : label;
}

/** What a row says about its own state. */
function stateText(row: ShareRow): string {
  if (row.state === "skipped") return "Lectern did not import this.";
  if (row.state === "failed") return "Could not import this.";
  return row.docIds.length > 1 ? `${row.docIds.length} documents added to the library.` : "Added to the library.";
}

/**
 * Run one planned action through the import pipeline (F§7.2, F§10.4). Files go to the hub's own parse; images are
 * read on this device by the scan tab's path, so a shared photograph is recognised by the phone's ML Kit engine
 * and never uploaded. A share whose images carried no text is a refusal, not an empty document.
 */
async function importAction(action: ShareAction): Promise<ImportResult[]> {
  if (action.kind === "text") return [await importTextLocal(action.text)];
  if (action.kind === "url") return [await importUrl(action.url)];
  if (action.kind === "file") return [await importPickedFile({ uri: action.uri, name: action.name, mime: action.mime })];
  if (action.kind === "images") {
    const saved = await saveScan(await recognizePages(action.uris), action.uris);
    if (saved === null) throw new Error("No text was found in the shared images.");
    return [saved];
  }
  return [];
}

/** The screen's styles, from the theme's tokens. */
type ScreenStyles = ReturnType<typeof createStyles>;

/** One row of the plan: what will be imported, what happened to it, and why it was not. */
function PlannedRow({ entry, row, styles }: { entry: PlannedAction; row: ShareRow | null; styles: ScreenStyles }) {
  return (
    <View style={styles.item} testID={`share-row-${row === null ? "planned" : row.state}`}>
      <Text style={styles.itemLabel} numberOfLines={1}>
        {labelFor(entry.action)}
      </Text>
      <Text style={styles.itemState}>{row === null ? "Waiting to import." : stateText(row)}</Text>
      {row === null || row.note === null ? null : <Text style={styles.itemNote}>{row.note}</Text>}
    </View>
  );
}

export default function HandleShareScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { sharedPayloads, resolvedSharedPayloads, isResolving, error, clearSharedPayloads } = useIncomingShare();

  const [plan, setPlan] = useState<PlannedAction[] | null>(null);
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const planned = useRef(false);

  /** Run the plan: one row per action, each written as it lands, then the payloads are cleared. */
  const run = useCallback(
    async (actions: readonly PlannedAction[]): Promise<void> => {
      setBusy(true);
      const finished: ShareRow[] = [];
      for (const entry of actions) {
        const { id, action } = entry;
        if (action.kind === "unsupported") {
          finished.push({ id, action, state: "skipped", note: action.reason, docIds: [] });
          continue;
        }
        try {
          const results = await importAction(action);
          finished.push({ id, action, state: "done", note: null, docIds: results.map((result) => result.docId) });
        } catch (cause) {
          finished.push({ id, action, state: "failed", note: problemOf(cause), docIds: [] });
        }
        setRows([...finished]);
      }
      setBusy(false);
      clearSharedPayloads();
      const docIds = finished.flatMap((row) => row.docIds);
      if (docIds.length === 1) router.replace(`/read/${docIds.join("")}`);
      else if (docIds.length > 1) router.replace("/library");
    },
    [clearSharedPayloads, router],
  );

  /**
   * Plan once the payloads have resolved, and import a share that is only text or only an address straight away.
   * The guard is a ref rather than a state because the answer is needed inside the effect before React has
   * committed anything, and because `clearSharedPayloads()` re-renders this screen with an empty payload list.
   */
  useEffect(() => {
    if (planned.current || isResolving) return;
    if (resolvedSharedPayloads.length === 0) return;
    planned.current = true;
    const actions = planShare(resolvedSharedPayloads).map((action, index) => ({ id: `share-${index}`, action }));
    setPlan(actions);
    const immediate = actions.every((entry) => entry.action.kind === "text" || entry.action.kind === "url");
    if (actions.length > 0 && immediate) void run(actions);
  }, [resolvedSharedPayloads, isResolving, run]);

  const settled = !isResolving && error === null && plan === null;
  const unreadable = settled && sharedPayloads.length > 0;
  const nothing = settled && sharedPayloads.length === 0;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Shared with Lectern" }} />

      <Text style={styles.heading}>Shared with Lectern</Text>

      {isResolving ? (
        <View style={styles.status} testID="resolving-share">
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>Reading what was shared…</Text>
        </View>
      ) : null}

      {busy ? (
        <View style={styles.status} testID="importing-share">
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.hint}>Importing…</Text>
        </View>
      ) : null}

      {error === null ? null : (
        <Text style={styles.error} testID="share-error">
          {problemOf(error)}
        </Text>
      )}

      {nothing ? (
        <Text style={styles.hint} testID="nothing-shared">
          Nothing was shared with Lectern. Open this screen from another app&apos;s share sheet.
        </Text>
      ) : null}

      {unreadable ? (
        <Text style={styles.error} testID="unreadable-share">
          The shared items could not be read.
        </Text>
      ) : null}

      {plan === null ? null : (
        <>
          <Text style={styles.label}>{plan.length === 1 ? "1 item" : `${plan.length} items`}</Text>
          {plan.map((entry) => (
            <PlannedRow
              key={entry.id}
              entry={entry}
              row={rows === null ? null : (rows.find((candidate) => candidate.id === entry.id) ?? null)}
              styles={styles}
            />
          ))}

          {busy || rows !== null ? null : (
            <Pressable style={styles.button} onPress={() => void run(plan)} accessibilityRole="button" testID="import-share">
              <Text style={styles.buttonText}>{plan.length === 1 ? "Import this item" : `Import ${plan.length} items`}</Text>
            </Pressable>
          )}
          <Pressable style={styles.secondary} onPress={() => router.replace("/library")} accessibilityRole="button" testID="open-library">
            <Text style={styles.secondaryText}>Open the library</Text>
          </Pressable>
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
    hint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    label: { color: theme.colors.ink, fontSize: theme.type.label, marginTop: theme.spacing.two },
    error: { color: theme.colors.danger, fontSize: theme.type.caption },
    status: { alignItems: "center", flexDirection: "row", gap: theme.spacing.two },
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
    item: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.one,
      padding: theme.spacing.three,
    },
    itemLabel: { color: theme.colors.ink, flexShrink: 1, fontSize: theme.type.label, fontWeight: "600" },
    itemState: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    itemNote: { color: theme.colors.danger, fontSize: theme.type.caption },
  });
}
