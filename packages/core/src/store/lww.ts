/**
 * The last-writer-wins rule every store and the hub share (F§5.9): the comparison two records of the same
 * entity are ordered by, so a device that applies remote changes reaches the same state as the one that
 * made them, whatever order the changes arrive in.
 */

/** What the rule compares: the stamp of one mutation (F§5.9). */
export interface Version {
  ts: number;
  deviceId: string;
}

/**
 * `isNewer(a, b)` — F§5.9's rule verbatim: `a` wins when its timestamp is greater, or when the timestamps
 * are equal and its device identifier is the greater string.
 *
 * Equality is *not* newer, so applying the same op twice changes nothing and two devices that have both
 * seen a record cannot keep rewriting it. The device comparison is a plain string comparison, which is why
 * `dev-9` sorts after `dev-10` — an identifier's order is lexical, never numeric.
 */
export function isNewer(a: Version, b: Version): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.deviceId > b.deviceId;
}
