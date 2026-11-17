/**
 * The root layout (F§10.4).
 *
 * A stack over a tab group, wrapped in the two providers every screen below needs: the safe-area provider so a
 * screen can pad itself away from the status bar and the gesture bar, and the theme provider so the tokens a
 * screen draws with are the ones the operating system's colour scheme asks for.
 *
 * No screen is named for its options here beyond hiding the stack header over the tab group: expo-router
 * registers a route per file, and each screen sets its own title and icon where the screen lives.
 */

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { getStores } from "../src/stores";
import { syncService } from "../src/sync/sync-service";
import { ThemeProvider, useTheme } from "../src/theme";

/** The stack itself, inside the providers, so its own colours come from the theme. */
function RootNavigator() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.colors.paper },
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.ink,
        headerTitleStyle: { color: theme.colors.ink, fontSize: theme.type.label, fontWeight: "600" },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  // F§8: this device's sync runs with the app and only with the app — the service is started here with the
  // app's own store, and taken down when the layout goes. It is inert while no hub is configured and while
  // the reader's own switch is off, so nothing below this line depends on it.
  useEffect(() => {
    let live = true;
    void (async () => {
      const stores = await getStores();
      if (!live) return;
      await syncService.start({ store: stores.store });
    })().catch(() => undefined);
    return () => {
      live = false;
      syncService.stop();
    };
  }, []);

  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <RootNavigator />
        <StatusBar style="auto" />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
