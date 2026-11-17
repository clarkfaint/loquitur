/**
 * Phase 5's library routes (F§7.2, F§8.4): the model and the original bytes of one document, addressed by
 * the `docId` in the path, with the size ceilings the hub enforces while it streams a body.
 *
 * A document's bytes are files under the data directory rather than rows (F§8.4), so the only shapes these
 * routes share are the identifier and the two limits below.
 */

import { z } from "zod";

/**
 * The `:docId` path parameter (F§7.2): F§5.2's identifier — the first 32 characters of the SHA-256 of the
 * block texts joined by a newline, in lower-case hexadecimal.
 *
 * It is pinned as a whole-string pattern rather than a length, because the value is used to build a path on
 * disk (F§8.4): a `docId` that could climb out of that path, or that a case-insensitive file system would
 * fold onto another document's, has to be refused before anything is opened.
 */
export const DocIdParamSchema = z.string().regex(/^[0-9a-f]{32}$/);
export type DocIdParam = z.infer<typeof DocIdParamSchema>;

/**
 * F§7.1's `LECTERN_MAX_UPLOAD_MB` default of 100 MiB, in bytes: the ceiling a hub applies to a body it reads,
 * so an upload is refused as it streams rather than after being held whole in memory.
 */
const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * The ceiling on a model upload, `PUT /v1/library/documents/:docId/model` (F§7.2): the gzipped
 * `DocumentModel` JSON a client sends before the `document` op that references it (F§8.2).
 */
export const MAX_MODEL_UPLOAD_BYTES = UPLOAD_LIMIT_BYTES;

/**
 * The ceiling on an original-file upload, `PUT /v1/library/documents/:docId/original` (F§7.2): the source
 * bytes a client keeps so a document can be re-parsed without the hub.
 */
export const MAX_ORIGINAL_UPLOAD_BYTES = UPLOAD_LIMIT_BYTES;
