/**
 * The background service worker (F§10.2).
 *
 * It does two things and nothing else: it installs the message router, so every message of the extension's
 * protocol is answered, and it runs the startup features in order. Playback, extraction and highlighting all
 * belong to other contexts — this one holds no player state, so it may be terminated between messages and
 * nothing is lost.
 */

import { defineBackground } from "wxt/utils/define-background";
import { features } from "../src/background/features";
import { installRouter } from "../src/background/router";

export default defineBackground(() => {
  installRouter();
  for (const feature of features) {
    feature();
  }
});
