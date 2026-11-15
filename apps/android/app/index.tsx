/**
 * The app's entry route (F§10.4).
 *
 * A deep link into Lectern carries an address and a token (`lectern://setup?…`) and nothing that says where to
 * go next, so the app starts at one of two places: the library, once a hub connection is saved, because that is
 * where a reader's documents are and an unconfigured app has none to show; and Settings while no connection is
 * saved, because the address and F§11's token are the one thing the app cannot work without.
 *
 * The connection is read from the platform's secure store, which is asynchronous, so this route holds a spinner
 * for the moment it takes. A store that cannot be read at all sends the reader to Settings too: that is the
 * screen where a broken connection is repaired, and it is a better answer than a spinner that never resolves.
 */

import { Redirect } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { getConnection } from "../src/connection";
import { type Theme, useTheme } from "../src/theme";

/** Where a reader who has no usable connection is sent. */
const SETTINGS = "/settings";

/** Where a reader whose hub is configured is sent. */
const LIBRARY = "/library";

export default function IndexScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
