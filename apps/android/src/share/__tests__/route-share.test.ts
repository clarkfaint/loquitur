/**
 * The share planner's tests (AGENTS.md §7).
 *
 * `route-share.ts` is the whole of the decision about what a share becomes, and it is the one module of this unit
 * that can be proved under Node: the handler screen stands on React Native and the platform's share module, and
 * is covered by the on-device run a later unit verifies through `adb`. The six cases the contract names are here —
 * plain text, a lone address, a PDF, three images in order, a mixed share, and an audio item — plus the three
 * edges the same rules imply: a file the hub cannot read, an `.html` file, which arrives labelled as a website
 * while its bytes are a copy in this app's cache, and a document that declares no type and is read by its
 * extension. The redirect that turns the platform's share launch into the handler route is a pure function in
 * `app/+native-intent.ts`, and the last block covers it, because AGENTS.md §7 asks every exported function for a
 * test.
 *
 * The payloads are built by two helpers, one per shape the module reports, from the installed typings. Every
 * string here is original Lectern test text and reserves example addresses; the URIs are the shapes the platform
 * itself gives a copy — `file:/…` in this app's cache — not paths that exist anywhere.
 */

import type { TextBasedResolvedSharePayload, UriBasedResolvedSharePayload } from "expo-sharing";
import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "../../../app/+native-intent";
import { planShare } from "../route-share";

/**
 * A share of text. The module's parser sets no `contentUri` and no resolved type for one, so neither is set here
 * either: that absence is exactly what makes the payload a piece of text.
 */
function sharedText(value: string): TextBasedResolvedSharePayload {
  return {
    value,
    shareType: "text",
    mimeType: "text/plain",
    contentUri: null,
    contentType: "text",
    contentMimeType: null,
    originalName: null,
    contentSize: null,
  };
}

/** What a share of a file, an image or an address reports: the copy (or the address), and the type resolved for it. */
interface CopyFields {
  value: string;
  shareType: "url" | "file" | "image" | "audio";
  contentType: "website" | "file" | "image" | "audio";
  contentUri: string;
  contentMimeType: string | null;
  originalName: string | null;
  mimeType?: string;
}

function sharedCopy(fields: CopyFields): UriBasedResolvedSharePayload {
  return {
    value: fields.value,
    shareType: fields.shareType,
    mimeType: fields.mimeType ?? "text/plain",
    contentUri: fields.contentUri,
    contentType: fields.contentType,
    contentMimeType: fields.contentMimeType,
    originalName: fields.originalName,
    contentSize: null,
  };
}

/** The copy an image or a file was given in this app's cache, under the name it was shared with. */
function cacheCopy(name: string): string {
  return `file:/data/user/0/dev.lectern.app/cache/expo-sharing/6c1f2a0e/${name}`;
}

describe("planShare", () => {
  it("reads a shared paragraph as text", () => {
    const text = "The ferry leaves at dawn, before the tide turns.";
    expect(planShare([sharedText(text)])).toEqual([{ kind: "text", text }]);
  });

  it("reads a lone address as a URL for the hub to fetch", () => {
    const address = "https://reader.example.org/notes/lecture-3";
    expect(
      planShare([
        sharedCopy({
          value: address,
          shareType: "url",
          contentType: "website",
          contentUri: address,
          contentMimeType: "text/html",
          originalName: "lecture-3",
        }),
      ]),
    ).toEqual([{ kind: "url", url: address }]);
  });

  it("reads a shared document as a file, by its copy and the name it was shared under", () => {
    const copy = cacheCopy("notes.pdf");
    expect(
      planShare([
        sharedCopy({
          value: "content://com.android.providers.downloads.documents/document/1234",
          shareType: "file",
          contentType: "file",
          contentUri: copy,
          contentMimeType: "application/pdf",
          originalName: "notes.pdf",
        }),
      ]),
    ).toEqual([{ kind: "file", uri: copy, name: "notes.pdf", mime: "application/pdf" }]);
  });

  it("gathers three images into one action, in the order they were shared", () => {
    const photos = ["ridge.jpg", "creek.jpg", "pier.jpg"];
    const payloads = photos.map((name) =>
      sharedCopy({
        value: `content://media/external/images/media/${name}`,
        shareType: "image",
        contentType: "image",
        contentUri: cacheCopy(name),
        contentMimeType: "image/jpeg",
        originalName: name,
      }),
    );
    expect(planShare(payloads)).toEqual([{ kind: "images", uris: photos.map(cacheCopy) }]);
  });

  it("plans a mixed share one action per item, with the images still one action", () => {
    const pdf = cacheCopy("chapter-4.pdf");
    const first = cacheCopy("page-1.png");
    const second = cacheCopy("page-2.png");
    const text = "Read this again before Thursday.";
    const actions = planShare([
      sharedCopy({
        value: "content://com.android.providers.downloads.documents/document/43",
        shareType: "file",
        contentType: "file",
        contentUri: pdf,
        contentMimeType: "application/pdf",
        originalName: "chapter-4.pdf",
      }),
      sharedCopy({
        value: "content://media/external/images/media/1",
        shareType: "image",
        contentType: "image",
        contentUri: first,
        contentMimeType: "image/png",
        originalName: "page-1.png",
      }),
      sharedText(text),
      sharedCopy({
        value: "content://media/external/images/media/2",
        shareType: "image",
        contentType: "image",
        contentUri: second,
        contentMimeType: "image/png",
        originalName: "page-2.png",
      }),
    ]);
    expect(actions).toEqual([
      { kind: "file", uri: pdf, name: "chapter-4.pdf", mime: "application/pdf" },
      { kind: "images", uris: [first, second] },
      { kind: "text", text },
    ]);
  });

  it("refuses an audio item and says why", () => {
    expect(
      planShare([
        sharedCopy({
          value: "content://media/external/audio/media/77",
          shareType: "audio",
          contentType: "audio",
          contentUri: cacheCopy("recording.mp3"),
          contentMimeType: "audio/mpeg",
          originalName: "recording.mp3",
        }),
      ]),
    ).toEqual([{ kind: "unsupported", reason: "Audio and video shares are not imported." }]);
  });
});

describe("planShare's edges", () => {
  it("refuses a file whose type and extension the hub does not read, naming the type", () => {
    expect(
      planShare([
        sharedCopy({
          value: "content://com.android.providers.downloads.documents/document/9",
          shareType: "file",
          contentType: "file",
          contentUri: cacheCopy("bundle.zip"),
          contentMimeType: "application/zip",
          originalName: "bundle.zip",
        }),
      ]),
    ).toEqual([{ kind: "unsupported", reason: "The hub cannot read this file type (application/zip)." }]);
  });

  it("reads a shared .html file as a file, though the platform labels it a website", () => {
    const copy = cacheCopy("chapter.html");
    expect(
      planShare([
        sharedCopy({
          value: "content://com.android.providers.downloads.documents/document/21",
          shareType: "file",
          contentType: "website",
          contentUri: copy,
          contentMimeType: "text/html",
          originalName: "chapter.html",
        }),
      ]),
    ).toEqual([{ kind: "file", uri: copy, name: "chapter.html", mime: "text/html" }]);
  });

  it("reads a document that declares no type from the extension it was shared under", () => {
    const copy = cacheCopy("notes.docx");
    expect(
      planShare([
        sharedCopy({
          value: "content://com.android.providers.downloads.documents/document/55",
          shareType: "file",
          contentType: "file",
          contentUri: copy,
          contentMimeType: null,
          originalName: "notes.docx",
          mimeType: "application/octet-stream",
        }),
      ]),
    ).toEqual([{ kind: "file", uri: copy, name: "notes.docx", mime: "application/octet-stream" }]);
  });
});

describe("redirectSystemPath", () => {
  it("sends the share module's launch to the handler screen", () => {
    expect(redirectSystemPath({ path: "lectern://expo-sharing", initial: true })).toBe("/handle-share");
  });

  it("passes the app's other addresses and its own routes through unchanged", () => {
    expect(redirectSystemPath({ path: "lectern://setup?hubUrl=x&token=y", initial: true })).toBe("lectern://setup?hubUrl=x&token=y");
    expect(redirectSystemPath({ path: "/library", initial: false })).toBe("/library");
  });
});
