/**
 * The mini page (F§10.1, F§10.3): the compact player the desktop shell's always-on-top window loads, and the
 * page a second browser tab can open to drive the reader that is already playing.
 *
 * It is a bus **remote** and nothing else: it owns no player, no chunk source and no document. It paints the
 * snapshots the reader tab publishes and turns every button into a command sent back over the bus, so the tab
 * that holds the audio is the only tab that plays it and the two views cannot drift apart.
 */

import { createBroadcastChannelTransport, createPlayerBus, PLAYER_CHANNEL, PlayerBar, type PlayerBusSnapshot } from "@lectern/ui-web";
import { type ReactElement, useEffect, useState } from "react";

export function MiniPage(): ReactElement {
  // One bus for the page's whole life: a `useState` initialiser is the one place a value is built once.
  const [bus] = useState(() => createPlayerBus(createBroadcastChannelTransport(PLAYER_CHANNEL), "remote"));
  const [snapshot, setSnapshot] = useState<PlayerBusSnapshot | null>(null);

  useEffect(() => {
    const stop = bus.onSnapshot(setSnapshot);
    return () => {
      stop();
      bus.dispose();
    };
  }, [bus]);

  return (
    <main className="lectern-mini">
      <h1 className="lectern-mini__title">{snapshot === null ? "" : snapshot.title}</h1>
      {snapshot === null ? (
        <p className="lectern-mini__empty" role="status">
          No document is open in a reader tab yet.
        </p>
      ) : (
        <PlayerBar
          baseWpm={snapshot.baseWpm}
          onCommand={(command) => bus.send(command)}
          progressFraction={snapshot.progressFraction}
          remainingMs={snapshot.remainingMs}
          snapshot={snapshot}
          variant="compact"
          voices={[]}
        />
      )}
    </main>
  );
}
