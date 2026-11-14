/**
 * The app's shell (F§10.1): the navigation bar and the content outlet, plus the one redirect the shell owns.
 *
 * The navigation is built from the route registry rather than written out, so a unit that registers a screen
 * gets its navigation entry with no edit here — and a pattern with a parameter (`/read/:docId`) is skipped,
 * because a document's reader is reached from the library rather than from the bar.
 *
 * With no hub configured the app belongs on the settings screen whatever the address bar asked for: there is
 * nothing to read from and nowhere to read it to. The redirect goes through the router's own `navigate`, so
 * the browser's back button behaves as it does anywhere else.
 */

import { type ReactElement, useEffect } from "react";
import { matchRoute, navigate, useHashRoute } from "./router";
import { routes } from "./routes";
import { applyTheme, useSettingsStore } from "./settings/settings";

/** The screen a fresh install starts on (F§10.1). */
const SETTINGS_PATH = "/settings";

/** A navigation label from a route's pattern: `/settings` reads as `Settings`. */
function labelFor(pattern: string): string {
  const segment = pattern.split("/").find((part) => part !== "");
  if (segment === undefined) return "Home";
  const words = segment.replace(/-/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the shell shows when nothing claims the location (the library and import screens arrive later). */
function NoScreen({ path }: { path: string }): ReactElement {
  return (
    <p className="lectern-shell__empty" role="status">
      Nothing is registered for <code>{path}</code> yet.
    </p>
  );
}

export function App(): ReactElement {
  const route = useHashRoute();
  const configured = useSettingsStore((state) => state.connection.hubUrl !== "");
  const theme = useSettingsStore((state) => state.preferences.theme);

  // The reader's theme is the stylesheet's attribute on the root element (F§10.1, `@lectern/ui-web`).
  useEffect(() => {
    applyTheme(theme, document.documentElement);
  }, [theme]);

  useEffect(() => {
    if (!configured && route.path !== SETTINGS_PATH) navigate(SETTINGS_PATH);
  }, [configured, route.path]);

  const matched = routes
    .map((candidate) => ({ candidate, match: matchRoute(candidate.pattern, route.hash) }))
    .find((entry) => entry.match !== null);
  const Screen = matched?.candidate.component;

  return (
    <div className="lectern-shell">
      <header className="lectern-shell__bar">
        <p className="lectern-shell__wordmark">Lectern</p>
        <nav className="lectern-shell__nav" aria-label="Primary">
          {routes
            .filter((candidate) => !candidate.pattern.includes(":"))
            .map((candidate) => (
              <a
                key={candidate.pattern}
                className="lectern-shell__link"
                href={`#${candidate.pattern}`}
                aria-current={route.path === candidate.pattern ? "page" : undefined}
              >
                {labelFor(candidate.pattern)}
              </a>
            ))}
        </nav>
      </header>
      <div className="lectern-shell__content">{Screen === undefined ? <NoScreen path={route.path} /> : <Screen />}</div>
    </div>
  );
}
