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

export const exportQuerySchema = z
  .object({
    scope: exportScopeSchema,
    variant: exportVariantSchema,
    format: exportFormatSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const isPotfile = data.format === 'hashcat-potfile' || data.format === 'john-potfile'
    const isCsvOnly = data.variant === 'plaintext-only' || data.variant === 'uncracked'
    if (isPotfile && isCsvOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `format '${data.format}' requires variant 'cracked-pairs'; '${data.variant}' does not include hash values`,
        path: ['format'],
      })
    }
  })
  .openapi('ExportQuery')
