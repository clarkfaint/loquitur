/**
 * The tab group (F§10.4).
 *
 * The navigator lists every screen file in this directory by itself — expo-router builds a route from each
 * file it finds, so there is no per-screen entry to keep in step with the directory. Each screen sets its own
 * title and icon from where it lives, and a screen added by a later unit appears here without this file
 * changing.
 *
 * The bar's colours come from the theme; nothing else about it is restyled, so the platform's own tab
 * behaviour (long-press menus, the selected tab's state, re-entrancy) is intact.
 */

import { Tabs } from "expo-router";
import { useTheme } from "../../src/theme";

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
    />
  );
}
