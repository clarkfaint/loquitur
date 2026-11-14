import { defineConfig } from "wxt";

/**
 * The extension's build configuration (F§10.2).
 *
 * WXT generates `manifest.json` from this file and from the entrypoints on disk, which is why the manifest
 * is written here rather than by hand: `permissions` names the five APIs this client uses, the hub origin is
 * *optional* and requested at run time (`optional_host_permissions`, F§11), and the four `commands` are the
 * keyboard shortcuts Chrome itself delivers — the extension installs no key listener of its own.
 *
 * The React module supplies the JSX transform and the React import preset; nothing else is added, so no
 * remote code, no store listing, no update URL and no analytics reach the built package (F§11).
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Lectern",
    description: "Read the page you are on out loud, sentence by sentence, with your own reader.",
    permissions: ["activeTab", "scripting", "storage", "offscreen", "contextMenus"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    commands: {
      "toggle-play": {
        suggested_key: { default: "Alt+Shift+P" },
        description: "Play or pause the current reading",
      },
      "read-page": {
        suggested_key: { default: "Alt+Shift+R" },
        description: "Start reading the page in the active tab",
      },
      "next-sentence": {
        suggested_key: { default: "Alt+Shift+Right" },
        description: "Skip one sentence forward",
      },
      "previous-sentence": {
        suggested_key: { default: "Alt+Shift+Left" },
        description: "Skip one sentence back",
      },
    },
  },
});
