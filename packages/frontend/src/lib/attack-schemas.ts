import { z } from 'zod'

/**
 * Coerces an empty form value into `undefined` before validating as a
 * positive integer. The form layer fills unselected resource dropdowns
 * with the empty string; that needs to round-trip to "field not set"
 * rather than fail validation.
 */
export const optionalResourceId = z.preprocess(
  (val) => (val === '' || val === null ? undefined : val),
  z.coerce.number().int().positive().optional()
)

/**
 * Parses the advanced-configuration textarea content as a JSON object.
 *
 * - Empty / whitespace-only -> undefined (field omitted from POST).
 * - Invalid JSON -> form error, blocks submit.
 * - JSON arrays / primitives / null -> form error (hashcat config is a
 *   key/value bag, not a list).
 *
 * The transform widens the schema input to `string | undefined` and the
 * output to `Record<string, unknown> | undefined`. Use `z.input<>` for
 * the form-bound type and `z.output<>` for the submit-bound type so the
 * mismatch is honest at the type level.
 */
export const advancedConfigSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw == null) return undefined
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // z.NEVER short-circuits the transform when validation fails;
      // ctx.addIssue surfaces the message on the field's `errors`.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be valid JSON',
      })
      return z.NEVER
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be a JSON object (e.g., {"workload-profile": 3})',
      })
      return z.NEVER
    }
    return parsed as Record<string, unknown>
  })

export const attackFormSchema = z.object({
  mode: z.coerce.number().int().nonnegative('Mode is required'),
  hashTypeId: optionalResourceId,
  wordlistId: optionalResourceId,
  rulelistId: optionalResourceId,
  masklistId: optionalResourceId,
  advancedConfiguration: advancedConfigSchema,
})

/** Form-bound shape: what react-hook-form actually stores (string for textarea). */
export type AttackFormInput = z.input<typeof attackFormSchema>
/** Submit-bound shape: parsed values after the resolver fires. */
export type AttackFormOutput = z.output<typeof attackFormSchema>
