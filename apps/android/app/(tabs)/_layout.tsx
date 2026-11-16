/**
 * The tab group (F§10.4).
 *
 * **Every screen is named here, with its own title and mark, and that is what makes the group render at all.**
 * expo-router builds a route from each file it finds in this directory, but a navigator only shows the screens
 * its layout declares: measured on the device, `<Tabs />` with no children draws an empty screen with no tab
 * bar, and expo-router says so in the log — *"No screens are declared in ./(tabs)/_layout.tsx, so the navigator
 * renders nothing. … Undeclared routes: scan, library, settings."*
 *
 * The titles and marks belong here for the same reason: a tab navigator draws every label and mark, not only
 * the visible tab's, so a screen that declared its own from its own body left the tabs it had not rendered yet
 * labelled `scan` and `settings` (measured) instead of F§10.4's names — the marks they are drawn with live in
 * `src/tabs/marks`.
 *
 * The bar's colours come from the theme; nothing else about it is restyled, so the platform's own tab
 * behaviour (long-press menus, the selected tab's state, re-entrancy) is intact.
 */

import { Tabs } from "expo-router";
import type { ReactElement } from "react";
import { LibraryMark, type MarkColor, ScanMark, SettingsMark } from "../../src/tabs/marks";
import { useTheme } from "../../src/theme";

/** One screen of the group: the file's own name in this directory, and the title and mark it is drawn with. */
interface TabScreen {
  name: string;
  title: string;
  Mark: ({ color }: { color: MarkColor | null }) => ReactElement;
}

/** The group's screens, in F§10.4's order: the library, the scanner, the settings. */
const SCREENS: readonly TabScreen[] = [
  { Mark: LibraryMark, name: "library", title: "Library" },
  { Mark: ScanMark, name: "scan", title: "Scan" },
  { Mark: SettingsMark, name: "settings", title: "Settings" },
];

export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: theme.colors.paper },
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.ink,
        headerTitleStyle: { color: theme.colors.ink, fontSize: theme.type.body, fontWeight: "600" },
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.inkMuted,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.line },
      }}
    >
      {SCREENS.map(({ Mark, name, title }) => (
        <Tabs.Screen key={name} name={name} options={{ tabBarIcon: ({ color }) => <Mark color={color} />, title }} />
      ))}
    </Tabs>
  );
}
