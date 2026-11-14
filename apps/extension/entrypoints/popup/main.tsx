/**
 * The popup document's entry point (F§10.2).
 *
 * The popup is an ordinary extension page: it has a DOM of its own, so React mounts into the element
 * `index.html` carries and nothing else about the page is touched. A popup document always has its root
 * element, so a missing one is a broken build rather than a case to handle quietly.
 */

import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("the popup document has no #root element");
}

createRoot(container).render(<Popup />);
