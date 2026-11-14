/**
 * The service worker's startup features (F§10.2).
 *
 * A feature is a function run once, when the service worker starts — a context menu registered on install, a
 * command binding wired to the message protocol, a session that watches the tab it is reading. They live in
 * this registry rather than in the entry point so that the entry point never changes: a later unit appends
 * its function here, and `background.ts` runs whatever the array holds.
 */

/** Every feature the service worker runs at startup, in order. */
export const features: (() => void)[] = [];
