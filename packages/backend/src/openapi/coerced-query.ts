/**
 * Helpers for coerce+catch+default query-string schemas with the
 * `.openapi(...)` annotation required for spec generation.
 *
 * Why the annotation is load-bearing: `@hono/zod-openapi`'s generator
 * (asteasolutions/zod-to-openapi) does not introspect through Zod 4's
 * `ZodCatch` wrapper — `app.getOpenAPI31Document(...)` throws
 * `UnknownZodTypeError` on any schema that uses `.catch(...)` without
 * an explicit `.openapi({ type: ... })` hint. Every dashboard
 * list-endpoint uses `.coerce.number().catch(default).default(default)`
 * for permissive pagination (so `?limit=abc` falls back to a sane
 * default instead of 400-ing), so without this helper the served
 * runtime spec at `/api/v1/dashboard/openapi.json` would 500.
 *
 * The annotation reflects the schema's effective output type and
 * bounds, NOT the raw `coerce` wrapper structure — consumers of the
 * generated spec see `{ type: integer, minimum, maximum?, default }`
 * which is what they actually care about. The validation runtime is
 * unchanged: `.catch()` still swallows malformed values, `.default()`
 * still fills in undefined.
 */

import { z } from '@hono/zod-openapi'

export interface CoercedIntegerQueryOpts {
  readonly min: number
  readonly max?: number
  readonly default: number
}

/**
 * Coerced integer query field with permissive fallback to `opts.default`
 * on either missing or malformed input. Use for `limit`, `offset`, and
 * similar pagination params.
 */
export function coercedIntegerQuery(opts: CoercedIntegerQueryOpts) {
  // Guard against swapped bounds at construction time. A schema with
  // `min > max` is unsatisfiable for any input, so every request would
  // silently fall through to `.catch(opts.default)` and the
  // `.min(...)`/`.max(...)` constraints would be load-bearing in name
  // only. Throwing at module load surfaces the bug at the boot path
  // rather than as a mysterious "every value defaults" runtime symptom.
  if (opts.max !== undefined && opts.max < opts.min) {
    throw new Error(`coercedIntegerQuery: max (${opts.max}) must be >= min (${opts.min})`)
  }
  const base = z.coerce.number().int().min(opts.min)
  const withMax = opts.max !== undefined ? base.max(opts.max) : base
  return withMax
    .catch(opts.default)
    .default(opts.default)
    .openapi({
      type: 'integer',
      minimum: opts.min,
      ...(opts.max !== undefined ? { maximum: opts.max } : {}),
      default: opts.default,
    })
}

/**
 * Coerced positive integer query field that resolves to `undefined`
 * on missing or malformed input (no default value). Use for optional
 * filter params (e.g., `?campaignId=`) where omission and bad input
 * should both yield "no filter".
 */
export function coercedOptionalPositiveIntegerQuery() {
  return z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .catch(undefined)
    .openapi({ type: 'integer', minimum: 1 })
}
