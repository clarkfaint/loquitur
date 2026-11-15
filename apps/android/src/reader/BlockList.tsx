/**
 * The reader's text (F§10.4, F§5.1).
 *
 * A virtualized list of the document's blocks. Only what is on screen is mounted, so a book-length document
 * costs the same as a page, and the block being read is the only one that is re-rendered as it moves.
 *
 * Three behaviours are the contract's:
 *
 * - **the active block is split into highlight runs** by `highlight-model.ts`, and no other block is;
 * - **a tap seeks**, and the tap target is the *sentence* — every block is one pressable run per sentence, never
 *   one element per word, so a paragraph costs its sentence count and not its word count;
 * - **the list follows the active block unless the reader scrolled recently.** F§10.1's rule (four seconds) is
 *   the same one here, and a drag is what sets it: `onScrollBeginDrag` fires for a finger and not for the
 *   list's own `scrollToOffset`, which is exactly the distinction that rule needs.
 *
 * Rows are scrolled by *measured* offset rather than by index. A block's height is its text's, so the list has
 * no `getItemLayout`, and React Native cannot scroll to an index it has not rendered — which is precisely the
 * case that matters here, since the reader follows a block that may be many screens away. Each row reports its
 * own `y` through `onLayout`, and the follow scroll uses that number.
 */

import type { Block, DocumentModel } from "@lectern/core";
import { memo, type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { FlatList, Text, View } from "react-native";
import { type Theme, useTheme } from "../theme";
import { type ActivePoint, blockIndexForSentence, type HighlightRole, segmentsForBlock } from "./highlight-model";

/** How long a manual scroll suspends the follow (F§10.1's four seconds). */
const MANUAL_SCROLL_MS = 4000;

/** How far above the followed block the list settles, so the line being read is not against the top edge. */
const FOLLOW_INSET = 8;

/** How far furniture is dimmed (F§10.4's reader, F§5.4's skipped blocks). */
const SKIPPED_OPACITY = 0.55;

/** The block's own text style, by kind — a heading reads as a heading, a quote as a quote (F§5.1). */
function blockTextStyle(styles: BlockStyles, block: Block) {
  switch (block.kind) {
    case "heading":
      return block.level === undefined || block.level <= 2 ? styles.headingOne : styles.headingTwo;
    case "quote":
      return styles.quote;
    case "caption":
    case "footnote":
      return styles.small;
    case "header":
    case "footer":
      return styles.small;
    default:
      return styles.body;
  }
}

/** The style a highlight run draws with: F§10.4's two backgrounds, and nothing for plain text. */
function roleStyle(styles: BlockStyles, role: HighlightRole) {
  if (role === "sentence") return styles.sentence;
  if (role === "word") return styles.word;
  return undefined;
}

/**
 * The sentence a run of block text belongs to: the last sentence that starts at or before the run's first
 * character, or the block's first sentence for a run in the leading whitespace. F§5.1 gives a sentence its own
 * offsets into the block, so this is a search rather than arithmetic.
 */
function sentenceOwning(block: Block, offset: number): number | null {
  const first = block.sentences[0];
  if (first === undefined) return null;
  let owner = first.index;
  for (const sentence of block.sentences) {
    if (sentence.charStart > offset) break;
    owner = sentence.index;
  }
  return owner;
}

/**
 * The runs of one block, in document order, each one pressable so a tap seeks to the sentence it sits in.
 *
 * The active block's runs come from `segmentsForBlock`; every other block is split into its sentences and the
 * gaps between them. Both lists concatenate back to the block's own text.
 */
function runsFor(block: Block, active: ActivePoint | null, styles: BlockStyles, onSeek: (sentenceIndex: number) => void): ReactNode[] {
  if (active !== null) {
    const nodes: ReactElement[] = [];
    let offset = 0;
    for (const segment of segmentsForBlock(block, active)) {
      const start = offset;
      offset += segment.text.length;
      const owner = sentenceOwning(block, start);
      nodes.push(
        <Text
          key={`${start}:${segment.role}`}
          style={roleStyle(styles, segment.role)}
          accessibilityRole={owner === null ? undefined : "button"}
          onPress={owner === null ? undefined : () => onSeek(owner)}
        >
          {segment.text}
        </Text>,
      );
    }
    return nodes;
  }

  const nodes: ReactElement[] = [];
  let cursor = 0;
  for (const sentence of block.sentences) {
    if (sentence.charStart > cursor) {
      nodes.push(<Text key={`gap:${cursor}`}>{block.text.slice(cursor, sentence.charStart)}</Text>);
    }
    nodes.push(
      <Text key={`sentence:${sentence.index}`} accessibilityRole="button" onPress={() => onSeek(sentence.index)}>
        {block.text.slice(sentence.charStart, sentence.charEnd)}
      </Text>,
    );
    cursor = sentence.charEnd;
  }
  if (cursor < block.text.length) nodes.push(<Text key={`gap:${cursor}`}>{block.text.slice(cursor)}</Text>);
  return nodes;
}

/** The styles a row draws with, built once per theme. */
interface BlockStyles {
  row: object;
  rowSkipped: object;
  headingOne: object;
  headingTwo: object;
  body: object;
  quote: object;
  small: object;
  sentence: object;
  word: object;
  bullet: object;
}

/** One block's styles, from the theme's tokens and the stylesheet's rhythm. */
function createStyles(theme: Theme): BlockStyles {
  const text = { color: theme.colors.ink, fontSize: theme.type.body } as const;
  return {
    row: { marginBottom: theme.spacing.four },
    rowSkipped: { opacity: SKIPPED_OPACITY },
    headingOne: { ...text, fontSize: theme.type.body + 6, fontFamily: theme.fontFamily.sansEmphasis },
    headingTwo: { ...text, fontFamily: theme.fontFamily.sansEmphasis },
    body: { ...text, lineHeight: theme.type.body * 1.6 },
    quote: {
      ...text,
      borderLeftColor: theme.colors.line,
      borderLeftWidth: 3,
      color: theme.colors.inkMuted,
      fontStyle: "italic",
      lineHeight: theme.type.body * 1.6,
      paddingLeft: theme.spacing.three,
    },
    small: { ...text, color: theme.colors.inkMuted, fontSize: theme.type.label },
    sentence: { backgroundColor: theme.colors.sentence },
    word: { backgroundColor: theme.colors.word },
    bullet: { color: theme.colors.inkMuted },
  };
}

/** One row: the block's text, its own layout reported upward, and the bullet a list item needs. */
interface BlockRowProps {
  block: Block;
  active: ActivePoint | null;
  styles: BlockStyles;
  onSeek(sentenceIndex: number): void;
  onRowLayout(blockIndex: number, y: number): void;
}

const BlockRow = memo(function BlockRow({ block, active, styles, onSeek, onRowLayout }: BlockRowProps) {
  const listItem = block.kind === "list-item";
  return (
    <View
      style={block.skip ? [styles.row, styles.rowSkipped] : styles.row}
      onLayout={(event) => onRowLayout(block.index, event.nativeEvent.layout.y)}
    >
      <Text style={blockTextStyle(styles, block)}>
        {listItem ? <Text style={styles.bullet}>{"•  "}</Text> : null}
        {runsFor(block, active, styles, onSeek)}
      </Text>
    </View>
  );
});

export interface BlockListProps {
  /** The document to draw (F§5.1). */
  document: DocumentModel;
  /** The sentence and word being read, from the player's own clock (F§5.6(d)). */
  active: ActivePoint;
  /** Where a tap on a sentence wants playback to go. */
  onSeek(sentenceIndex: number): void;
}

/**
 * `BlockList` — the document's blocks, virtualized, with the active block highlighted and followed.
 */
export function BlockList({ document, active, onSeek }: BlockListProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const listRef = useRef<FlatList<Block> | null>(null);
  const offsets = useRef(new Map<number, number>());
  const lastManualScroll = useRef(0);

  const activeBlock = blockIndexForSentence(document, active.sentenceIndex);

  /** Remember where a row sits, which is how the list follows a block it has not rendered. */
  const onRowLayout = useCallback((blockIndex: number, y: number): void => {
    offsets.current.set(blockIndex, y);
  }, []);

  useEffect(() => {
    if (activeBlock === null) return;
    if (Date.now() - lastManualScroll.current < MANUAL_SCROLL_MS) return;
    const y = offsets.current.get(activeBlock);
    if (y === undefined) return;
    listRef.current?.scrollToOffset({ animated: true, offset: Math.max(0, y - FOLLOW_INSET) });
  }, [activeBlock]);

  const renderItem = useCallback(
    ({ item }: { item: Block }) => (
      <BlockRow
        block={item}
        active={item.index === activeBlock ? active : null}
        styles={styles}
        onSeek={onSeek}
        onRowLayout={onRowLayout}
      />
    ),
    [active, activeBlock, onRowLayout, onSeek, styles],
  );

  return (
    <FlatList
      ref={listRef}
      data={document.blocks}
      keyExtractor={(block) => String(block.index)}
      renderItem={renderItem}
      extraData={active}
      onScrollBeginDrag={() => {
        lastManualScroll.current = Date.now();
      }}
      contentContainerStyle={{ padding: theme.spacing.four }}
      style={{ backgroundColor: theme.colors.paper }}
    />
  );
}
