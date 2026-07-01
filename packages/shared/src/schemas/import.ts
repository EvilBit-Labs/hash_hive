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
 * Request body for the pre-cracked import endpoint.
 *
 * The hash-list id is a path parameter, not a body field.
 * Route-level validation (U7) extends this with multipart/form-data
 * file handling; the body shape here covers the parseable discriminator.
 */
export const importRequestSchema = z
  .object({
    format: importFormatSchema,
  })
  .strict()
  .openapi('ImportRequest')
