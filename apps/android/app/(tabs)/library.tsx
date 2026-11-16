/**
 * The library tab (F§10.4, F§5.9, F§10.1).
 *
 * The screen is a view of F§5.9's records and nothing more. It reads the live documents, the live folders and
 * how far each document is read, and it draws the list the reader's search, folder chip and sort ask for —
 * through `@lectern/core`'s own library model (`buildFolderTree`, `filterDocuments`, `sortDocuments`), which is
 * the same code the web app's library draws itself with, so the two platforms cannot filter or sort the same
 * records differently. A row's percentage is `documentProgress`, which works from the counts the metadata
 * carries, so drawing a library never loads a document's model.
 *
 * Every action is a store write and the screen is re-read afterwards, which is why it never holds a second copy
 * of the library that a reload would contradict. Deleting writes F§5.9's tombstone — which travels to the
 * reader's other devices — and drops the two blobs keyed by the document's own `docId`, because they mean
 * nothing once the document is gone. Moving is an ordinary write: the model travels with the record rather than
 * the folder being patched into a stored row, which is what the web app's library does.
 *
 * The screen reads the store again every time it comes into focus, so a document imported on the import screen
 * is in the list by the time the reader is back.
 *
 * Every row also carries F§10.1's offline control beside it, and that control is a view of the same store:
 * whether a document has a pack is a `setting` record rather than something the screen remembers, so the
 * control reads it when the row appears and again after every action it takes. It is a sibling of the row's
 * own pressable, so a thumb on "Offline" cannot open the reader.
 */

import {
  buildFolderTree,
  type DocumentFilter,
  type DocumentMeta,
  type DocumentSortOrder,
  documentProgress,
  type Folder,
  type FolderNode,
  filterDocuments,
  sortDocuments,
} from "@lectern/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { anchorsKey, originalKey } from "../../src/import/import-service";
import { OfflineButton } from "../../src/offline/OfflineButton";
import { getStores } from "../../src/stores";
import { radius, type Theme, useTheme } from "../../src/theme";

/** The orders the list offers (F§10.1), and the label each one is offered under. */
const SORT_ORDERS: readonly DocumentSortOrder[] = ["addedAt", "title", "progress"];
const ORDER_LABELS: Readonly<Record<DocumentSortOrder, string>> = { addedAt: "Added", title: "Title", progress: "Progress" };

/** The records the screen draws: every live document, every live folder, and each document's fraction. */
interface LibrarySnapshot {
  documents: DocumentMeta[];
  folders: Folder[];
  progress: Readonly<Record<string, number>>;
}

/** The empty library a screen starts on, before the first read of the store answers. */
const EMPTY: LibrarySnapshot = { documents: [], folders: [], progress: {} };

/** What the document list is filtered by: everything, or one folder — `null` being the unfiled documents. */
type FolderFilter = { kind: "all" } | { kind: "folder"; id: string | null };

/** One folder the chip row draws, with how deep it sits in the tree. */
interface FolderRow {
  folder: Folder;
  depth: number;
}

/** Which view the sheet under a long press is showing. */
type SheetMode = "actions" | "move" | "delete";

/** A failure as the sentence a reader can act on. */
function problemOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A fraction as the percentage a row shows. */
function asPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Read the whole library: the live documents, the live folders, and each document's progress as the fraction a
 * row shows (F§5.6(f), worked out from the counts the metadata carries).
 */
async function readLibrary(): Promise<LibrarySnapshot> {
  const { store } = await getStores();
  const [documents, folders] = await Promise.all([store.listDocuments(), store.listFolders()]);
  const entries = await Promise.all(
    documents.map(async (document): Promise<[string, number]> => {
      const progress = await store.getProgress(document.docId);
      return [document.docId, documentProgress(document, progress)];
    }),
  );
  return { documents, folders, progress: Object.fromEntries(entries) };
}

/** A tree flattened into the chips it is drawn as, parents before their children. */
function flattenFolderTree(nodes: readonly FolderNode[], depth = 0): FolderRow[] {
  return nodes.flatMap((node) => [{ folder: node.folder, depth }, ...flattenFolderTree(node.children, depth + 1)]);
}

export default function LibraryScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<DocumentSortOrder>("addedAt");
  const [filter, setFilter] = useState<FolderFilter>({ kind: "all" });
  const [selected, setSelected] = useState<DocumentMeta | null>(null);
  const [mode, setMode] = useState<SheetMode>("actions");

  const load = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await readLibrary());
      setProblem(null);
    } catch (cause) {
      setProblem(problemOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // The library is read whenever the tab comes into focus, so a document imported on the import screen is
  // already in the list when the reader returns to it.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Run a store action, and read the library back so the screen shows what was written. */
  const act = useCallback(
    async (work: () => Promise<void>): Promise<void> => {
      try {
        await work();
        setProblem(null);
      } catch (cause) {
        setProblem(problemOf(cause));
      }
      await load();
    },
    [load],
  );

  /** File a document in another folder (F§5.9): the record is stamped again, and the model travels with it. */
  const moveDocument = useCallback(
    async (document: DocumentMeta, folderId: string | null): Promise<void> => {
      await act(async () => {
        const { store } = await getStores();
        const model = await store.getDocumentModel(document.docId);
        if (model === null) return;
        await store.putDocument({ ...document, folderId }, model);
      });
      setSelected(null);
    },
    [act],
  );

  /**
   * Delete a document: F§5.9's tombstone through the store, and with it the two blobs that belong to the
   * document alone — its original bytes and its anchors, which are keyed by `docId`. The model goes with the
   * tombstone, which is the store's own business.
   */
  const removeDocument = useCallback(
    async (document: DocumentMeta): Promise<void> => {
      await act(async () => {
        const { store, cache } = await getStores();
        await store.deleteDocument(document.docId);
        await cache.delete(originalKey(document.docId));
        await cache.delete(anchorsKey(document.docId));
      });
      setSelected(null);
    },
    [act],
  );

  /** What the list is filtered by right now, in F§5.9's own query shape. */
  const query = useMemo((): DocumentFilter => {
    const next: DocumentFilter = {};
    if (filter.kind === "folder") next.folderId = filter.id;
    if (search.trim() !== "") next.text = search;
    return next;
  }, [filter, search]);

  const folderRows = useMemo(() => flattenFolderTree(buildFolderTree(snapshot.folders)), [snapshot.folders]);
  const listed = useMemo(
    () => sortDocuments(filterDocuments(snapshot.documents, query), order, snapshot.progress),
    [snapshot.documents, snapshot.progress, query, order],
  );

  const openSheet = useCallback((document: DocumentMeta): void => {
    setSelected(document);
    setMode("actions");
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: DocumentMeta }) => (
      // The row's own pressable is unchanged — a tap opens the reader, a long press opens the sheet — and
      // F§10.1's offline control sits beside it rather than inside it, so a thumb on "Offline" cannot open the
      // reader and the accessibility tree keeps the control its own node.
      <View style={styles.row}>
        <Pressable
          style={styles.rowMain}
          onPress={() => router.push(`/read/${item.docId}`)}
          onLongPress={() => openSheet(item)}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          testID={`document-${item.docId}`}
        >
          <Text style={styles.rowTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.rowMeta}>{`${asPercent(snapshot.progress[item.docId] ?? 0)} read · ${item.wordCount} words`}</Text>
        </Pressable>
        <OfflineButton docId={item.docId} title={item.title} />
      </View>
    ),
    [openSheet, router, snapshot.progress, styles],
  );

  const header = (
    <View style={styles.header}>
      <Pressable style={styles.import} onPress={() => router.push("/import")} accessibilityRole="button" testID="open-import">
        <Text style={styles.importText}>Import</Text>
      </Pressable>

      <TextInput
        style={styles.input}
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Search titles"
        placeholderTextColor={theme.colors.inkMuted}
        testID="library-search"
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Pressable
          style={[styles.chip, filter.kind === "all" ? styles.chipOn : null]}
          onPress={() => setFilter({ kind: "all" })}
          accessibilityRole="button"
          testID="folder-all"
        >
          <Text style={styles.chipText}>All</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, filter.kind === "folder" && filter.id === null ? styles.chipOn : null]}
          onPress={() => setFilter({ kind: "folder", id: null })}
          accessibilityRole="button"
          testID="folder-none"
        >
          <Text style={styles.chipText}>No folder</Text>
        </Pressable>
        {folderRows.map((row) => (
          <Pressable
            key={row.folder.id}
            style={[
              styles.chip,
              { marginLeft: row.depth * theme.spacing.two },
              filter.kind === "folder" && filter.id === row.folder.id ? styles.chipOn : null,
            ]}
            onPress={() => setFilter({ kind: "folder", id: row.folder.id })}
            accessibilityRole="button"
            testID={`folder-${row.folder.id}`}
          >
            <Text style={styles.chipText}>{row.folder.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.sortRow}>
        {SORT_ORDERS.map((value) => (
          <Pressable
            key={value}
            style={[styles.chip, order === value ? styles.chipOn : null]}
            onPress={() => setOrder(value)}
            accessibilityRole="button"
            testID={`sort-${value}`}
          >
            <Text style={styles.chipText}>{ORDER_LABELS[value]}</Text>
          </Pressable>
        ))}
        <Text style={styles.count} testID="library-count">{`${listed.length} of ${snapshot.documents.length}`}</Text>
      </View>

      {problem === null ? null : <Text style={styles.problem}>{problem}</Text>}
    </View>
  );

  const empty = loading ? (
    <ActivityIndicator color={theme.colors.accent} style={styles.spinner} />
  ) : snapshot.documents.length === 0 ? (
    <View style={styles.empty}>
      <Text style={styles.emptyHeading} testID="library-empty">
        The library is empty
      </Text>
      <Text style={styles.emptyHint}>Import a file, a link, or some text to read aloud.</Text>
    </View>
  ) : (
    <View style={styles.empty}>
      <Text style={styles.emptyHeading} testID="library-no-match">
        Nothing matches this view
      </Text>
      <Text style={styles.emptyHint}>Try another search, another folder, or All.</Text>
    </View>
  );

  return (
    <View style={styles.page}>
      <FlatList
        style={styles.page}
        contentContainerStyle={styles.content}
        data={listed}
        keyExtractor={(item) => item.docId}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
      />

      <Modal visible={selected !== null} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setSelected(null)}
          accessibilityRole="button"
          accessibilityLabel="Close the document actions"
        />
        <View style={styles.sheet}>
          {selected === null ? null : (
            <>
              <Text style={styles.sheetHeading} numberOfLines={2}>
                {selected.title}
              </Text>

              {mode === "actions" ? (
                <>
                  <Pressable style={styles.sheetButton} onPress={() => setMode("move")} accessibilityRole="button" testID="action-move">
                    <Text style={styles.sheetButtonText}>Move to a folder…</Text>
                  </Pressable>
                  <Pressable style={styles.sheetButton} onPress={() => setMode("delete")} accessibilityRole="button" testID="action-delete">
                    <Text style={styles.sheetButtonText}>Delete…</Text>
                  </Pressable>
                  <Pressable style={styles.sheetCancel} onPress={() => setSelected(null)} accessibilityRole="button" testID="action-cancel">
                    <Text style={styles.sheetCancelText}>Cancel</Text>
                  </Pressable>
                </>
              ) : null}

              {mode === "move" ? (
                <>
                  <ScrollView style={styles.sheetList}>
                    <Pressable
                      style={styles.sheetButton}
                      onPress={() => void moveDocument(selected, null)}
                      accessibilityRole="button"
                      testID="move-none"
                    >
                      <Text style={styles.sheetButtonText}>No folder</Text>
                    </Pressable>
                    {folderRows.map((row) => (
                      <Pressable
                        key={row.folder.id}
                        style={styles.sheetButton}
                        onPress={() => void moveDocument(selected, row.folder.id)}
                        accessibilityRole="button"
                        testID={`move-${row.folder.id}`}
                      >
                        <Text style={styles.sheetButtonText}>{row.folder.name}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                  <Pressable style={styles.sheetCancel} onPress={() => setMode("actions")} accessibilityRole="button" testID="move-back">
                    <Text style={styles.sheetCancelText}>Back</Text>
                  </Pressable>
                </>
              ) : null}

              {mode === "delete" ? (
                <>
                  <Text style={styles.sheetHint}>
                    It leaves the library here and on the reader's other devices, and its cached audio goes with it.
                  </Text>
                  <Pressable
                    style={styles.sheetButton}
                    onPress={() => void removeDocument(selected)}
                    accessibilityRole="button"
                    testID="delete-confirm"
                  >
                    <Text style={styles.sheetDanger}>Delete this document</Text>
                  </Pressable>
                  <Pressable style={styles.sheetCancel} onPress={() => setMode("actions")} accessibilityRole="button" testID="delete-back">
                    <Text style={styles.sheetCancelText}>Back</Text>
                  </Pressable>
                </>
              ) : null}
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}

/** The screen's styles, from the theme's tokens. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: { backgroundColor: theme.colors.paper, flex: 1 },
    content: { gap: theme.spacing.two, padding: theme.spacing.four, paddingBottom: theme.spacing.five },
    header: { gap: theme.spacing.two },
    import: {
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      borderRadius: radius.two,
      height: theme.control.size,
      justifyContent: "center",
    },
    importText: { color: theme.colors.accentInk, fontSize: theme.type.label, fontWeight: "600" },
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
    chips: { alignItems: "center", gap: theme.spacing.two },
    chip: {
      alignItems: "center",
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.three,
      borderWidth: 1,
      justifyContent: "center",
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.four,
    },
    chipOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
    chipText: { color: theme.colors.ink, fontSize: theme.type.label },
    sortRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.two },
    count: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    problem: { color: theme.colors.danger, fontSize: theme.type.caption },
    spinner: { marginTop: theme.spacing.five },
    empty: { gap: theme.spacing.one, paddingVertical: theme.spacing.five },
    emptyHeading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600" },
    emptyHint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    row: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      gap: theme.spacing.one,
      padding: theme.spacing.three,
    },
    rowMain: { gap: theme.spacing.one },
    rowTitle: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600" },
    rowMeta: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
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
      maxHeight: "70%",
      padding: theme.spacing.four,
      position: "absolute",
      right: 0,
    },
    sheetHeading: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600" },
    sheetHint: { color: theme.colors.inkMuted, fontSize: theme.type.caption },
    sheetList: { maxHeight: 260 },
    sheetButton: {
      backgroundColor: theme.colors.paper,
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      justifyContent: "center",
      marginBottom: theme.spacing.two,
      minHeight: theme.control.size,
      paddingHorizontal: theme.spacing.three,
    },
    sheetButtonText: { color: theme.colors.ink, fontSize: theme.type.label },
    sheetDanger: { color: theme.colors.danger, fontSize: theme.type.label, fontWeight: "600" },
    sheetCancel: {
      alignItems: "center",
      borderColor: theme.colors.line,
      borderRadius: radius.two,
      borderWidth: 1,
      height: theme.control.size,
      justifyContent: "center",
    },
    sheetCancelText: { color: theme.colors.inkMuted, fontSize: theme.type.label },
  });
}
