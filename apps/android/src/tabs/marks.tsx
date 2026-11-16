/**
 * The tab group's marks (F§10.4).
 *
 * Each mark is drawn from views rather than an icon font or an asset, so the bar depends on nothing the
 * platform might not have. They live here — beside the group's layout and not in the three screens that use
 * them — because a tab navigator draws *every* label and mark, not only the visible tab's, and a screen's own
 * `<Tabs.Screen options={{ … }} />` only reaches the navigator once that screen has been rendered: measured on
 * the device, the two tabs that had not been opened yet drew their route names (`scan`, `settings`) in place of
 * their titles while the open one drew `Library`. The layout declares them, so all three are right from the
 * first frame.
 */

import { StyleSheet, View, type ViewStyle } from "react-native";

/**
 * The colour a tab navigator hands its icon: `ViewStyle["backgroundColor"]` without its `undefined`, quoting
 * the installed `react-native@0.88.1` (`types_generated/Libraries/StyleSheet/StyleSheetTypes.d.ts`).
 */
export type MarkColor = NonNullable<ViewStyle["backgroundColor"]>;

/** The bars the library's and the settings' marks are made of. A mark's own width goes on each bar. */
const barStyle = StyleSheet.create({
  box: { gap: 3, height: 18, justifyContent: "center", width: 18 },
  bar: { borderRadius: 2, height: 3 },
});

/** Lectern's library mark: a list of rows. */
export function LibraryMark({ color }: { color: MarkColor | null }) {
  return (
    <View style={barStyle.box}>
      <View style={[barStyle.bar, { backgroundColor: color }]} />
      <View style={[barStyle.bar, { backgroundColor: color }]} />
      <View style={[barStyle.bar, { backgroundColor: color }]} />
    </View>
  );
}

/** Lectern's scan mark: the four corners of a page. */
export function ScanMark({ color }: { color: MarkColor | null }) {
  return (
    <View style={cornerStyle.box}>
      <View style={[cornerStyle.corner, cornerStyle.topLeft, { borderColor: color }]} />
      <View style={[cornerStyle.corner, cornerStyle.topRight, { borderColor: color }]} />
      <View style={[cornerStyle.corner, cornerStyle.bottomLeft, { borderColor: color }]} />
      <View style={[cornerStyle.corner, cornerStyle.bottomRight, { borderColor: color }]} />
    </View>
  );
}

/** Lectern's settings mark: the app icon's three bars, of decreasing width. */
export function SettingsMark({ color }: { color: MarkColor | null }) {
  return (
    <View style={barStyle.box}>
      <View style={[barStyle.bar, { backgroundColor: color, width: 18 }]} />
      <View style={[barStyle.bar, { backgroundColor: color, width: 13 }]} />
      <View style={[barStyle.bar, { backgroundColor: color, width: 8 }]} />
    </View>
  );
}

const cornerStyle = StyleSheet.create({
  box: { height: 18, position: "relative", width: 18 },
  corner: { height: 6, position: "absolute", width: 6 },
  topLeft: { borderLeftWidth: 2, borderTopWidth: 2, left: 0, top: 0 },
  topRight: { borderRightWidth: 2, borderTopWidth: 2, right: 0, top: 0 },
  bottomLeft: { borderBottomWidth: 2, borderLeftWidth: 2, bottom: 0, left: 0 },
  bottomRight: { borderBottomWidth: 2, borderRightWidth: 2, bottom: 0, right: 0 },
});
