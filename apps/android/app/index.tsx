/**
 * The app's entry route (F§10.4).
 *
 * A deep link into Lectern carries an address and a token (`lectern://setup?…`) and nothing that says where
 * to go next, so the app starts at one place: the tab group. Reading a document happens from the library or a
 * reader link, and both are reached from a tab.
 */

import { Redirect } from "expo-router";

export default function IndexScreen() {
  return <Redirect href="/settings" />;
}
