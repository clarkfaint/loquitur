/**
 * The service worker's startup features (F§10.2).
 *
 * A feature is a function run once, when the service worker starts — a context menu registered on install, a
 * command binding wired to the message protocol, a session that watches the tab it is reading. They live in
 * this registry rather than in the entry point so that the entry point never changes: a later unit appends
 * its function here, and `background.ts` runs whatever the array holds.
 */

import { installOffscreenBridge } from "./offscreen";
import { installReadActiveTab } from "./read-active-tab";
import { installReadingSession } from "./session";

/** Every feature the service worker runs at startup, in order. */
export const features: (() => void)[] = [];

// U-034's two. The settings channel goes first: the offscreen document opens its port on its own first line, and
// a connection nothing is listening for is closed immediately. The reading session then watches the tab events
// it stops on. Both are installers rather than registrations, so this array stays the whole list of features.
features.push(installOffscreenBridge, installReadingSession);

// U-035's. It registers `ext/read-active-tab` and binds the `read-page` shortcut to the same request, so a
// reading starts from the popup's button or from the keyboard and arrives in the content script the same way.
features.push(installReadActiveTab);
