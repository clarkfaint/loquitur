/**
 * The content script's startup features (F§10.2).
 *
 * The mirror of the service worker's own list, and for the same reason: a later unit appends its function here
 * and `entrypoints/content/index.ts` runs whatever the array holds, so the entry point never changes. A feature
 * is a function of the page's context — it registers the messages it answers, the listeners it needs and the
 * highlight it paints, and it is installed once, when the script runs at `document_idle`.
 */

import { type ContentContext, installReadingSession } from "./reading-session";
import { installWidget } from "./widget/mount";

/** Every feature the content script installs, in order. */
export const contentFeatures: ((ctx: ContentContext) => void)[] = [];

// U-035's one. The reading session is what makes the page readable at all: it extracts the article, paints the
// player's position and turns an `Alt`+click into a place to start.
contentFeatures.push(installReadingSession);

// U-036's one. The floating widget: the reader's controls on a page the extension does not own, offered on load
// when the settings ask for it and mounted whenever it is the widget that starts a reading. It is installed
// after the reading session because both listen for `ext/snapshot`, and the session is the one that paints.
contentFeatures.push(installWidget);
