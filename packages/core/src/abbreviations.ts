/**
 * Abbreviation tokens for the tokenizer (F§5.3), tokenizerVersion 1.
 *
 * A candidate sentence boundary is rejected when the single `.` before it follows one of these tokens,
 * and the two sets hold the two *different* reasons a token can be an abbreviation.
 *
 * `CASE_INSENSITIVE_ABBREVIATIONS` holds tokens that are never ordinary words, so any spelling of them
 * suppresses a boundary: `Dr.` and `dr.` behave the same, `U.S.` is matched through its inner dots,
 * and the month short forms cover `Jan.` in either case.
 *
 * `EXACT_CASE_ABBREVIATIONS` holds tokens that *are* ordinary words when written lower-case, so only
 * the spelling listed here suppresses a boundary. It carries the legal-citation abbreviations, which is
 * the whole reason it exists: `Open the app.` still ends a sentence while `Cal. App. 4th` does not, and
 * `id.` in running text is not the reporter citation `Id.`
 *
 * Both sets are fixed by the architecture brief and are exported as `ReadonlySet` so that no caller can
 * add to them at run time; the tokenizer's golden cases depend on their exact membership.
 */

export const CASE_INSENSITIVE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "fig",
  "eq",
  "vol",
  "pp",
  "cf",
  "approx",
  "dept",
  "inc",
  "corp",
  "ltd",
  "llc",
  "u.s",
  "jan",
  "feb",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

export const EXACT_CASE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "St",
  "No",
  "Mar",
  "Co",
  "Ed",
  "Est",
  "Art",
  "App",
  "Cal",
  "Ch",
  "Sec",
  "Id",
  "Op",
  "Ct",
  "Rev",
  "Stat",
  "Supp",
  "Cir",
  "Rptr",
  "al",
]);
