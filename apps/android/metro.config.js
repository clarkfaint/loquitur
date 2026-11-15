/**
 * Metro for the Android app (F§10.4).
 *
 * The Expo default configuration, which is also the monorepo configuration: `@expo/metro-config` walks up
 * from the project directory to the workspace root it finds through the lockfile, adds that root to
 * `watchFolders`, and looks for modules in both the project's and the root's `node_modules` — so a
 * `workspace:*` dependency (`@lectern/core`, `@lectern/api-client`) both resolves and is watched as source.
 * Nothing is added here; the file exists so a reader can see that the default is deliberate.
 *
 * CommonJS on purpose: Metro loads this file with `require`, so the package declares no `"type": "module"`.
 */

const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
