/**
 * Text normalization (F§5.2). The eight steps below run in the order the contract fixes, because the
 * order is load-bearing: line endings are unified before anything works line by line, and runs of
 * spaces and tabs are collapsed before each line is trimmed.
 *
 * The result is a fixed point: no leading or trailing whitespace, no run of two spaces or tabs, no run
 * of three newlines, no non-breaking space and no soft hyphen. Normalizing it again returns it
 * unchanged, which is what the idempotence test asserts.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\u00AD/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
