/**
 * The queue's bookkeeping (F§5.8, F§10.4): which chunk the native playlist is on, and which of F§5.8's events
 * that position implies.
 *
 * The playlist is a native object. It plays an ordered list of sources and reports where it is; JavaScript is
 * not awake between two items, which is exactly why F§10.4 puts the queue there. Everything the sink has to
 * *say* about that position — a chunk starting, a chunk ending, the queue running out — is therefore derived
 * from indexes, and this module is the derivation: pure, synchronous, and testable under Node, where no native
 * object exists at all.
 *
 * Two facts about the platform shape the rules. Both were read from the installed `expo-audio`'s own Android
 * source:
 *
 * - a **track change** is reported only when the index actually changed, so the *first* item's start is the
 *   caller's own news to report — `previousIndex` of `NO_PREVIOUS_INDEX` says "playback is starting rather than
 *   moving", and the platform's own reports never carry a negative index;
 * - the **end of the last item** is not a track change at all. It arrives as a status report whose index is
 *   still the item that finished, which is why a report whose two indexes are equal means "the chunk the map
 *   is on has finished" rather than "nothing happened".
 *
 * The map's index is the *playlist's* index. Chunk ids are recorded in the order they were enqueued and
 * nothing is ever removed from the middle, so `chunkIds[i]` is the item at playlist index `i` for the life of
 * the queue. A drain keeps that index — the playlist is still parked on the item that finished — and marks it
 * finished instead, which is what makes a repeated report harmless, what makes `currentChunk()` answer `null`
 * once the queue has run out, and what lets the platform's next report (the item the playlist moves on to)
 * start the next chunk without ending the finished one a second time.
 */

/** One event the sink must report. F§5.8 gives a sink four; the queue itself decides these three. */
export type QueueMapEvent = { type: "chunk-start"; chunkId: string } | { type: "chunk-end"; chunkId: string } | { type: "queue-empty" };

/** The `previousIndex` that means "nothing was playing before this report". */
export const NO_PREVIOUS_INDEX = -1;

/** What `createQueueMap()` answers: the four members a sink needs of the queue's bookkeeping. */
export interface QueueMap {
  /** Record a chunk as the queue's next item, and answer the playlist index it will have. */
  append(chunkId: string): number;
  /** The events one playlist report implies, in the order they must be emitted. */
  onTrackChanged(previousIndex: number, currentIndex: number): QueueMapEvent[];
  /** Forget everything: the queue holds nothing and nothing is playing. */
  reset(): void;
  /** The chunk the playlist is on, or `null` when nothing is playing. */
  currentChunk(): string | null;
}

/** `createQueueMap()` — one queue's bookkeeping, and no state outside it. */
export function createQueueMap(): QueueMap {
  /** The chunks in playlist order: `chunkIds[i]` is the item at playlist index `i`. */
  const chunkIds: string[] = [];
  /** The playlist index the map believes is current, or `null` before anything has started. */
  let index: number | null = null;
  /** Whether the chunk at `index` has already been reported as finished. */
  let finished = false;

  /** The chunk at one playlist index, or `undefined` when the map holds none there. */
  const chunkAt = (at: number | null): string | undefined => (at === null ? undefined : chunkIds[at]);

  return {
    append(chunkId) {
      chunkIds.push(chunkId);
      return chunkIds.length - 1;
    },

    onTrackChanged(previousIndex, currentIndex) {
      const events: QueueMapEvent[] = [];

      // Equal indexes: the platform's way of saying the queue ran out. Only the chunk the map is on can be the
      // one that finished, and it finishes once — a second report finds the map already past it.
      if (currentIndex === previousIndex) {
        if (index !== currentIndex || finished) return events;
        const ended = chunkAt(index);
        finished = true;
        if (ended === undefined) return events;
        events.push({ type: "chunk-end", chunkId: ended });
        events.push({ type: "queue-empty" });
        return events;
      }

      // A real move: whatever the map was on ends first, unless it has already ended.
      const previous = chunkAt(index);
      if (previous !== undefined && !finished && index !== currentIndex) {
        events.push({ type: "chunk-end", chunkId: previous });
      }

      const started = chunkAt(currentIndex);
      if (started === undefined) {
        // A report about an item this map holds no chunk for: a cleared queue, or an index left over from one.
        // Nothing starts, and nothing is playing.
        index = null;
        finished = false;
        return events;
      }
      // The item the map is already on: a resume, or a report about the chunk that just finished. No change.
      if (index === currentIndex) return events;

      index = currentIndex;
      finished = false;
      events.push({ type: "chunk-start", chunkId: started });
      return events;
    },

    reset() {
      chunkIds.length = 0;
      index = null;
      finished = false;
    },

    currentChunk() {
      if (finished) return null;
      return chunkAt(index) ?? null;
    },
  };
}
