/**
 * The import flows and the library, end to end (F§10.1, F§13 phase 2).
 *
 * What these cases drive is a real hub — `global-setup.ts` starts one with the mock engine — through the
 * screens a reader uses: a file picked, the same file again, a plain-text file, text pasted, a folder tree,
 * a move, a filter, a search, a delete that asks first, and reloads that have to show the same library.
 *
 * The title the fixture PDF arrives under is read from the fixtures' own `expected.json` rather than written
 * here: that file is what the generator promised the fixture's title is, and a test that restated it would
 * pass even if the generator's promise changed.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { connect, importText } from "./helpers";

/** The fixture PDF, the fixture text file, and the record of what the generator wrote about them. */
const PDF = fileURLToPath(new URL("../../../packages/fixtures/generated/text.pdf", import.meta.url));
const PLAIN_FILE = fileURLToPath(new URL("../../../packages/fixtures/generated/sample.txt", import.meta.url));
const EXPECTED = fileURLToPath(new URL("../../../packages/fixtures/generated/expected.json", import.meta.url));

/** What `expected.json` says about the fixtures. */
interface FixtureExpectations {
  title: string;
}

/** The fixture documents' shared title. */
async function fixtureTitle(): Promise<string> {
  const expectations = JSON.parse(await readFile(EXPECTED, "utf8")) as FixtureExpectations;
  return expectations.title;
}

/** The two pasted documents this spec uses: one to file and find, one to filter and delete. */
const HARBOUR_TITLE = "Harbour Notes";
const HARBOUR_TEXT = [
  "A harbour at first light is a study in patience.",
  "The water holds the colour of the sky and gives nothing back until the wind moves it.",
  "Boats that came in before dark are already tied, and their crews are asleep below decks.",
  "Nothing here is in a hurry, which is the whole point of a harbour.",
].join(" ");

const KITCHEN_TITLE = "Kitchen Notes";
const KITCHEN_TEXT = [
  "A kitchen table remembers every meal it has held.",
  "The scratches near the near edge are from years of plates arriving in a hurry.",
  "Someone carved a date into the far corner, and nobody alive can say what happened that day.",
  "It is a plain table, and it is the most used piece of furniture in the house.",
].join(" ");

/** The document rows a reader sees, keyed by the document they are, never by their title. */
function rows(page: Page) {
  return page.locator("[data-doc-id]");
}

test("a fixture PDF uploads once, the same file is a duplicate, and a text file is its own document", async ({ page }) => {
  await connect(page);
  const title = await fixtureTitle();

  await page.goto("/#/import");
  await page.setInputFiles("#lectern-import-file", PDF);
  await expect(page.locator('[data-import-item][data-status="done"]')).toHaveCount(1);

  await page.goto("/#/library");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();

  // The same document again: the hub reads the same `docId`, so the library is not added to.
  await page.goto("/#/import");
  await page.setInputFiles("#lectern-import-file", PDF);
  await expect(page.locator('[data-import-item][data-status="duplicate"]')).toHaveCount(1);
  await page.goto("/#/library");
  await expect(rows(page)).toHaveCount(1);

  // A plain-text file is read the same way and is a document of its own — which is why the library can hold
  // two documents under one title: a document is identified by its text, not by what it is called.
  await page.goto("/#/import");
  await page.setInputFiles("#lectern-import-file", PLAIN_FILE);
  await expect(page.locator('[data-import-item][data-status="done"]')).toHaveCount(1);
  await page.goto("/#/library");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(2);

  // What was imported is in the database rather than in the page, so it is there after a reload.
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
});

test("pasted text, a folder tree, a move, a filter, a search, a delete and a reload", async ({ page }) => {
  await connect(page);
  await importText(page, HARBOUR_TITLE, HARBOUR_TEXT);
  await importText(page, KITCHEN_TITLE, KITCHEN_TEXT);

  await page.goto("/#/library");
  await expect(rows(page)).toHaveCount(2);

  // A folder at the root…
  await page.getByLabel("New folder").fill("Reading list");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.locator('[data-depth="0"]')).toHaveCount(1);

  // …and one inside it, because the selected folder is where a new folder is created.
  await page.getByRole("button", { name: "Reading list", exact: true }).click();
  await page.getByLabel("New folder").fill("Chapter one");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.locator('[data-depth="1"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Chapter one", exact: true })).toBeVisible();

  // A folder is renamed, which is a write like any other.
  await page.getByRole("button", { name: "Rename Chapter one" }).click();
  await page.getByLabel("New name for Chapter one").fill("Chapter two");
  await page.getByRole("button", { name: "Save name for Chapter one" }).click();
  await expect(page.getByRole("button", { name: "Chapter two", exact: true })).toBeVisible();

  // Everything again, and one document filed in the folder.
  await page.getByRole("button", { name: "All documents", exact: true }).click();
  await page.getByLabel(`Move ${HARBOUR_TITLE}`).selectOption({ label: "Reading list" });
  await expect(rows(page)).toHaveCount(2);

  // Filtering by the folder keeps the document filed in it and hides the other.
  await page.getByRole("button", { name: "Reading list", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("link", { name: HARBOUR_TITLE, exact: true })).toBeVisible();

  // Searching by title keeps the one whose title carries the fragment.
  await page.getByRole("button", { name: "All documents", exact: true }).click();
  await page.getByLabel("Search").fill("Kitchen");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("link", { name: KITCHEN_TITLE, exact: true })).toBeVisible();
  await page.getByLabel("Search").fill("");

  // The folders, the nesting and the filing are records, so a reload finds them all again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Reading list", exact: true })).toBeVisible();
  await expect(page.locator('[data-depth="1"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Reading list", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("link", { name: HARBOUR_TITLE, exact: true })).toBeVisible();

  // A delete asks first, and the confirmation is what writes the tombstone.
  await page.getByRole("button", { name: "All documents", exact: true }).click();
  await page.getByRole("button", { name: `Delete ${KITCHEN_TITLE}` }).click();
  await page.getByRole("button", { name: `Confirm delete ${KITCHEN_TITLE}` }).click();
  await expect(rows(page)).toHaveCount(1);

  // Deleting a folder is not deleting what was filed in it: the child folder moves up to the root and the
  // document stays where it is.
  await page.getByRole("button", { name: "Delete Reading list" }).click();
  await page.getByRole("button", { name: "Confirm delete Reading list" }).click();
  await expect(page.getByRole("button", { name: "Reading list", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-depth="1"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Chapter two", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  // And the library after the reload is the library before it.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("link", { name: HARBOUR_TITLE, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chapter two", exact: true })).toBeVisible();
});
