/**
 * The app's entry route (F§10.4).
 *
 * A deep link into Lectern carries an address and a token (`lectern://setup?…`) and nothing that says where to
 * go next, so the app starts at one of two places: the library, once a hub connection is saved, because that is
 * where a reader's documents are and an unconfigured app has none to show; and Settings while no connection is
 * saved, because the address and F§11's token are the one thing the app cannot work without.
 *
 * **The redirect belongs to `/` and to nothing else.** This route is the stack's own initial route, so it stays
 * mounted underneath whatever a deep link opened — and a `<Redirect>` here navigates the *reader*, not this
 * unattended screen, which is how a link to `lectern://setup`, `lectern://diagnostics` or a share's
 * `lectern://expo-sharing` came to be replaced by the library or the settings a few seconds after the linked
 * screen had drawn (measured: a setup screen correct at t=12 s and gone at t=42 s with no input at all). The
 * reader's own address is therefore read first, and the redirect only happens while it is `/`.
 *
 * The connection is read from the platform's secure store, which is asynchronous, so this route holds a spinner
 * for the moment it takes. A store that cannot be read at all sends the reader to Settings too: that is the
 * screen where a broken connection is repaired, and it is a better answer than a spinner that never resolves.
 */

import { Redirect, usePathname } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { getConnection } from "../src/connection";
import { type Theme, useTheme } from "../src/theme";

/** Where a reader who has no usable connection is sent. The tab group's own path, which is the route that draws. */
const SETTINGS = "/(tabs)/settings";

/** Where a reader whose hub is configured is sent. */
const LIBRARY = "/(tabs)/library";

/** The one address this route answers to. Any other is a deep link's own screen, showing above this one. */
const ROOT = "/";

export default function IndexScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const pathname = usePathname();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getConnection()
      .then((connection) => {
        if (mounted) setTarget(connection === null ? SETTINGS : LIBRARY);
      })
      .catch(() => {
        if (mounted) setTarget(SETTINGS);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // A deep link is on screen, so this route is behind it and has nothing to show: redirecting from here would
  // replace the screen the reader asked for.
  if (pathname !== ROOT) return null;

  if (target === null) {
    return (
      <View style={styles.page}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return <Redirect href={target} />;
}

/** The one style this route needs: a page to hold the spinner while the connection is read. */
function createStyles(theme: Theme) {
  return StyleSheet.create({
    page: {
      alignItems: "center",
      backgroundColor: theme.colors.paper,
      flex: 1,
      justifyContent: "center",
    },
  });
}
