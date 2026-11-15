/**
 * The service worker's startup features (F§10.2).
 *
 * A feature is a function run once, when the service worker starts — a context menu registered on install, a
 * command binding wired to the message protocol, a session that watches the tab it is reading. They live in
 * this registry rather than in the entry point so that the entry point never changes: a later unit appends
 * its function here, and `background.ts` runs whatever the array holds.
 */

import { installCommands } from "./commands";
import { installContextMenu } from "./context-menu";
import { installOffscreenBridge } from "./offscreen";
import { installPdfHandoff } from "./pdf-handoff";
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

// U-037's three. The context menu and the keyboard commands are installers rather than registrations, and the
// PDF hand-off adds its own handler to the registry; all three go last, because a menu click and a player
// shortcut both act through the session the two features above installed.
features.push(installContextMenu, installCommands, installPdfHandoff);
