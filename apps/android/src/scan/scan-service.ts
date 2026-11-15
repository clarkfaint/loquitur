/**
 * Scanning pages and turning them into a document (F§10.4, F§5.5).
 *
 * Three steps, in the order the reader takes them:
 *
 * 1. `scanPages()` — the pages. F§10.4's camera path is `react-native-document-scanner-plugin`, the platform's
 *    own multi-page document scanner, which crops and deskews each page as it is photographed. It needs Google
 *    Play services, and F§14 names the case where a device has none: *"Devices without it get a single-photo
 *    capture path (U-051)"*. So the scanner is tried first and, when its screen cannot open at all, the reader
 *    takes one photograph at a time with `expo-image-picker` until they stop — both roads answer with the same
 *    thing, a list of page image URIs, so nothing downstream knows which one was used.
 * 2. `recognizePages(uris)` — the text. Each page is read by `@react-native-ml-kit/text-recognition`, on the
 *    device, and nothing leaves the phone: F§5.5 draws the boundary (*"Android does not use this pipeline for
 *    the camera. It runs ML Kit on-device and builds the document locally with `buildDocument`"*), so there is
 *    no hub client in this module at all. `linesFromRecognition` puts a page's lines into F§5.5's shape and
 *    `groupOcrLines` groups them into the paragraphs `buildDocument` takes.
 * 3. `saveScan(pages, uris)` — the document. `assembleScan` builds the model, `importDocumentModel` stores it
 *    exactly as a parsed file is stored, and the page images are then deleted: F§10.4 keeps no photographs of
 *    what it has read, so a finished scan leaves a document and no pictures behind.
 *
 * **Every platform module is loaded inside the function that needs it**, which is the rule the rest of this app
 * follows (`src/stores/expo-blob-fs.ts`, `src/import/import-service.ts`): the Node test program parses
 * `react-native` nowhere, and a page's recogniser should not be in memory before there is a page. It is also
 * what makes the fallback possible — `react-native-document-scanner-plugin` calls
 * `TurboModuleRegistry.getEnforcing` while it is being evaluated, so on a build without it the *import* is what
 * throws, and that is the signal to take the other road.
 */

import { groupOcrLines, type RawBlock } from "@lectern/core";
import { type ImportResult, importDocumentModel } from "../import/import-service";
import { assembleScan } from "./assemble";
import { linesFromRecognition, pageHeightOf } from "./mlkit-lines";

/** How many pages one scan may hold: F§10.4's multi-page scanner, bounded so a scan stays a document. */
export const MAX_SCAN_PAGES = 20;

/** The scanner's own module, or `null` when this build cannot offer it. */
type ScannerModule = typeof import("react-native-document-scanner-plugin");

/** The highest photograph quality the picker offers, so recognition reads the camera's own pixels. */
const FULL_QUALITY = 1;

/**
 * The document scanner, or `null` when its native module is not in this build. The module registers itself
 * through `TurboModuleRegistry.getEnforcing` as it is evaluated, which throws when the package was not linked
 * — the case a device without the package, or a build that left it out, presents here.
 */
async function loadScanner(): Promise<ScannerModule | null> {
  try {
    return await import("react-native-document-scanner-plugin");
  } catch {
    return null;
  }
}

/**
 * The pages the document scanner produced, or `null` when the scanner could not be opened at all. An empty list
 * is the reader closing the scanner before taking a page, which is an answer and not a failure.
 */
async function scanWithDocumentScanner(): Promise<string[] | null> {
  const scanner = await loadScanner();
  if (scanner === null) return null;
  let response: Awaited<ReturnType<ScannerModule["default"]["scanDocument"]>>;
  try {
    response = await scanner.default.scanDocument({
      maxNumDocuments: MAX_SCAN_PAGES,
      responseType: scanner.ResponseType.ImageFilePath,
    });
  } catch {
    // The scanner's screen could not be opened — no Play services, or no camera activity to hand it to.
    return null;
  }
  if (response.status !== scanner.ScanDocumentResponseStatus.Success) return [];
  return response.scannedImages ?? [];
}

/**
 * One photograph at a time, for the devices F§14 describes: the camera UI is asked for a picture, and asking
 * again is how the reader adds a page. Closing the camera is how they say they are done.
 */
async function capturePagesOneAtATime(): Promise<string[]> {
  const picker: typeof import("expo-image-picker") = await import("expo-image-picker");
  const permission = await picker.requestCameraPermissionsAsync();
  if (!permission.granted) return [];
  const uris: string[] = [];
  while (uris.length < MAX_SCAN_PAGES) {
    const shot = await picker.launchCameraAsync({ quality: FULL_QUALITY });
    if (shot.canceled) break;
    for (const asset of shot.assets) uris.push(asset.uri);
  }
  return uris;
}

/**
 * `scanPages()` — the page image URIs of one scan, newest last, at most `MAX_SCAN_PAGES` of them. The document
 * scanner is used when it is there; otherwise the reader takes the pages one photograph at a time. Either way an
 * empty list means the reader stopped before taking a page.
 */
export async function scanPages(): Promise<string[]> {
  const scanned = await scanWithDocumentScanner();
  if (scanned !== null) return scanned;
  return await capturePagesOneAtATime();
}

/**
 * `recognizePages(uris)` — each page read on this device, as the raw blocks F§5.5's grouping produces. One
 * entry per URI, in the order the pages were taken, so a page that read nothing is an empty list rather than a
 * page that went missing.
 */
export async function recognizePages(uris: readonly string[]): Promise<RawBlock[][]> {
  if (uris.length === 0) return [];
  const recognition: typeof import("@react-native-ml-kit/text-recognition") = await import("@react-native-ml-kit/text-recognition");
  const pages: RawBlock[][] = [];
  for (const uri of uris) {
    const result = await recognition.default.recognize(uri);
    pages.push(groupOcrLines(linesFromRecognition(result, pageHeightOf(result))));
  }
  return pages;
}

/** Whether a page image is still there — the platform's own copy of a scanned page, which this app may not own. */
async function removePageImage(fileSystem: typeof import("expo-file-system"), uri: string): Promise<boolean> {
  try {
    const file = new fileSystem.File(uri);
    if (!file.exists) return false;
    file.delete();
    return true;
  } catch {
    // A scanner may answer with a `content://` page it owns; this app's directory holds nothing to clean up.
    return false;
  }
}

/**
 * `discardScanImages(uris)` — delete the page images of a scan this reader has finished with, whether they were
 * saved or abandoned. F§10.4 keeps no photograph of a page once its text is in the library.
 */
export async function discardScanImages(uris: readonly string[]): Promise<void> {
  if (uris.length === 0) return;
  const fileSystem: typeof import("expo-file-system") = await import("expo-file-system");
  for (const uri of uris) await removePageImage(fileSystem, uri);
}

/**
 * `saveScan(pages, uris)` — assemble the pages into a document, store it, and delete the page images. Answers
 * `null` when the scan read no text at all, because then there is no document: nothing is stored and F§5.9's
 * library is not given an entry for a blank page.
 *
 * The images are deleted only once the model is safely stored, so an import that fails leaves the pages where
 * the reader can try again; the screen's own discard path is what clears a scan that is abandoned.
 */
export async function saveScan(pages: readonly RawBlock[][], uris: readonly string[]): Promise<ImportResult | null> {
  const document = assembleScan(pages, new Date());
  if (document.blocks.length === 0) {
    await discardScanImages(uris);
    return null;
  }
  const saved = await importDocumentModel(document);
  await discardScanImages(uris);
  return saved;
}
