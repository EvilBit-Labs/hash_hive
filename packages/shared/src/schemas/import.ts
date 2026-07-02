import '../openapi-extension.js'
import { z } from 'zod'

/**
 * Shared Zod schemas for the hash-import feature (issue #102).
 *
 * KTD7: importSummarySchema is compartmentalized to the target-list scope.
 * `matchedInList` and `crackedInList` are DB-derived aggregates computed by
 * the upsert layer (U8); cross-project propagation counts are never included.
 */

export const importFormatSchema = z
  .enum(['pairs', 'hashcat-potfile', 'john-potfile'])
  .openapi('ImportFormat')

/**
 * Compartmentalized import summary (KTD7).
 *
 * - matchedInList: rows in the target hash list whose hashValue appeared in
 *   the import content (computed by U8 upsert, not the parser).
 * - crackedInList: subset of matchedInList whose plaintext was updated by
 *   this import (computed by U8 upsert).
 * - skipped: lines the parser rejected (malformed, missing plaintext,
 *   overlong hashValue/username). Propagated from the parse result.
 */
export const importSummarySchema = z
  .object({
    matchedInList: z.number().int().nonnegative(),
    crackedInList: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('ImportSummary')

/**
 * Maximum byte-length of the `content` field in a pre-cracked import
 * request. Bounds an amplified-memory DoS from an authenticated
 * admin/contributor while still accommodating large production imports.
 * 32 MiB measured in UTF-8 bytes (not JavaScript char/code-unit count).
 */
export const IMPORT_CONTENT_MAX_LENGTH = 33_554_432

/**
 * Request body for the pre-cracked import endpoint.
 *
 * The hash-list id is a path parameter, not a body field.
 * Both the dashboard and control surfaces derive their per-surface
 * OpenAPI component name via `.openapi('<Surface>ImportPrecrackedRequest')`;
 * the shared definition is the authoritative wire schema (AGENTS.md rule:
 * wire shapes live in `@hashhive/shared`).
 */
export const importRequestSchema = z
  .object({
    content: z
      .string()
      .min(1, 'content must not be empty')
      // Cheap char-count gate first; the superRefine below enforces the
      // stricter UTF-8 byte bound for non-ASCII payloads.
      .max(IMPORT_CONTENT_MAX_LENGTH, 'content is too large')
      .superRefine((val, ctx) => {
        if (new TextEncoder().encode(val).length > IMPORT_CONTENT_MAX_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'content exceeds the 32 MiB UTF-8 byte limit',
          })
        }
      }),
    format: importFormatSchema,
  })
  .strict()
  .openapi('ImportRequest')
