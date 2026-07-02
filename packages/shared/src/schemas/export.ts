import '../openapi-extension.js'
import { z } from 'zod'

/**
 * Shared Zod schemas for the hash-export feature (issue #102).
 *
 * These three axes are orthogonal for CSV but constrained for potfile:
 *   - variant: what data to include (cracked-pairs | plaintext-only | uncracked)
 *   - format: the output encoding (csv | hashcat-potfile | john-potfile)
 *   - scope: the boundary of rows to include (hash-list | campaign | project)
 *
 * The `superRefine` below enforces the constraint: potfile formats require
 * cracked-pairs because a valid potfile line must contain both the hash
 * value and the recovered plaintext. Variants that omit the hash
 * (plaintext-only) or omit the plaintext (uncracked) are rejected at
 * parse time rather than silently producing an unusable output file.
 */

export const exportVariantSchema = z
  .enum(['cracked-pairs', 'plaintext-only', 'uncracked'])
  .openapi('ExportVariant')

export const exportFormatSchema = z
  .enum(['csv', 'hashcat-potfile', 'john-potfile'])
  .openapi('ExportFormat')

export const exportScopeSchema = z.enum(['hash-list', 'campaign', 'project']).openapi('ExportScope')

/**
 * Returns true when the combination of format and variant is invalid for
 * potfile output. Potfile formats require the hash value in every output line,
 * so variants that omit it ('plaintext-only') or omit the plaintext
 * ('uncracked') cannot produce a valid potfile.
 *
 * Used in:
 *   - the shared `exportQuerySchema.superRefine` below
 *   - the dashboard results route (after resolving optional defaults)
 *   - the control export route's `superRefine` (separately imported)
 */
export function isPotfileVariantConflict(
  format: z.infer<typeof exportFormatSchema>,
  variant: z.infer<typeof exportVariantSchema>
): boolean {
  const isPotfile = format === 'hashcat-potfile' || format === 'john-potfile'
  const isCsvOnly = variant === 'plaintext-only' || variant === 'uncracked'
  return isPotfile && isCsvOnly
}

export const exportQuerySchema = z
  .object({
    scope: exportScopeSchema,
    variant: exportVariantSchema,
    format: exportFormatSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (isPotfileVariantConflict(data.format, data.variant)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `format '${data.format}' requires the cracked-pairs variant — potfiles need both the hash and its plaintext, which '${data.variant}' does not provide.`,
        path: ['format'],
      })
    }
  })
  .openapi('ExportQuery')
