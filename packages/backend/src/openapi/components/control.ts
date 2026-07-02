/**
 * Control surface OpenAPI plumbing.
 *
 * Seven named responses (`AuthError`, `Forbidden`, `NotFound`,
 * `ValidationError`, `Conflict`, `InternalError`, `ServiceUnavailable`)
 * point at the RFC 9457 problem-details envelope
 * (`application/problem+json`). Names mirror the pre-deletion
 * `packages/openapi/control-api.yaml` `components.responses` keys so
 * client codegen output stays stable across the route-as-spec cutover.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { ZodError } from 'zod'

import { z } from '@hono/zod-openapi'

import type { ResponseConfig } from './shared.js'

import { mapZodError, problemResponse } from '../../lib/problem-details.js'
import { guardDuplicateComponentRegistration } from './shared.js'

/**
 * RFC 9457 problem-details body returned by every Control API error
 * path. Field-for-field mirror of `ProblemBody` in
 * `lib/problem-details.ts` — both must drift together.
 *
 * `instance` is set to the request path at emit time; `errors[]` is
 * present only on `validation` problems (one entry per Zod issue).
 */
export const controlProblemDetailsSchema = z
  .object({
    type: z.string().describe('Stable URL identifier per RFC 9457 §3.1.'),
    title: z.string().describe('Short human-readable summary.'),
    status: z
      .number()
      .int()
      .describe('HTTP status code (also encoded in the envelope per RFC 9457).'),
    detail: z.string().describe('Specific human-readable detail about this occurrence.'),
    instance: z.string().describe('Request path the problem occurred on.'),
    errors: z
      .array(
        z.object({
          path: z.string(),
          code: z.string(),
          message: z.string(),
        })
      )
      .optional()
      .describe('Field-level validation errors (only on `validation` problems).'),
  })
  .openapi('ProblemDetails')

const CONTROL_RESPONSE_NAMES = [
  'AuthError',
  'Forbidden',
  'NotFound',
  'ValidationError',
  'Conflict',
  'InternalError',
  'ServiceUnavailable',
  // A record is permanent and archive-only (ADR-0019, issue #106 U6/U10) —
  // e.g. DELETE on a run attack.
  'UnprocessableEntity',
] as const

type ControlResponseName = (typeof CONTROL_RESPONSE_NAMES)[number]

declare const __CONTROL_REF_BRAND__: unique symbol
export type ControlResponseRef = `#/components/responses/${ControlResponseName}` & {
  readonly [__CONTROL_REF_BRAND__]: true
}

export const CONTROL_RESPONSE_REFS = Object.fromEntries(
  CONTROL_RESPONSE_NAMES.map((name) => [name, `#/components/responses/${name}`] as const)
) as {
  readonly [K in ControlResponseName]: `#/components/responses/${K}` & {
    readonly [__CONTROL_REF_BRAND__]: true
  }
}

const CONTROL_RESPONSE_DESCRIPTIONS: Record<ControlResponseName, string> = {
  AuthError: 'Authentication required - missing, invalid, or revoked Control API key.',
  Forbidden: 'Authenticated but not authorized for the target project or resource.',
  NotFound: "Target resource does not exist or is outside the caller's project scope.",
  ValidationError: 'Request body, query, or path parameters failed schema validation.',
  Conflict: 'Request conflicts with current resource state (e.g., duplicate key, FK in-use).',
  InternalError:
    'Unexpected server error - downstream dependency (database, queue, storage) failed and the request could not be completed.',
  ServiceUnavailable:
    'A required backing service is degraded or offline (e.g., Redis queue unavailable).',
  UnprocessableEntity:
    'Request is well-formed but cannot be processed because the target record is permanent and archive-only.',
}

/**
 * `$ref` wrapper for control-registry responses. The brand on
 * `ControlResponseRef` prevents cross-surface `$ref` leakage at
 * compile time (a dashboard route handing a `DashboardResponseRef`
 * to this function is a type error even when the name strings
 * happen to overlap, e.g. `Forbidden`).
 */
export function sharedControlResponse(ref: ControlResponseRef): ResponseConfig {
  return { $ref: ref } as unknown as ResponseConfig
}

/**
 * Default validation hook for every control `OpenAPIHono` router.
 * Maps Zod validation failures to the RFC 9457 `validation` problem
 * shape via `problemResponse` so all control routes return the same
 * `application/problem+json` envelope on bad input. Without this,
 * `@hono/zod-openapi`'s default produces a `{ success: false, error: ZodError }`
 * body that breaks every control-routes test asserting
 * `body.type === 'https://hashhive.dev/errors/validation'`.
 *
 * The hook surfaces each failing field via `errors[]` (path + code +
 * message) so consumers can render field-level errors without parsing
 * the `detail` string. `detail` itself stays concise ("Request
 * validation failed") since the structured `errors` carries the
 * specifics.
 */
export const controlOpenApiHonoOptions = {
  // Return contract is `Response | undefined`. **`undefined` MUST mean
  // "continue handler chain" — do NOT change this to `void`.** The
  // library inspects the return value: a `Response` short-circuits with
  // the validation envelope, anything not-a-Response (including `void`
  // or `null`) is treated as "fall through to the handler". Future
  // refactors that drop the early `return undefined` would silently
  // ship a 200 response with no body on every successful validation.
  //
  // The `detail` text is held verbatim ('Invalid request') to match
  // the wire envelope the pre-route-as-spec validation hook emitted.
  // The structured
  // `errors[]` array (via `mapZodError`) carries the actionable
  // field-level detail; consumers should parse that, not the prose
  // string. Drifting this detail wording is a wire-contract change.
  defaultHook: <E extends Env>(
    result: { success: true } | { success: false; error: ZodError },
    c: Context<E>
  ): Response | undefined => {
    if (result.success) return undefined
    // Cast through `as z.ZodError` at the hook boundary per the
    // GOTCHAS.md guidance: `@hono/zod-validator` v0.7 emits
    // `$ZodError` (zod v4 core), but `mapZodError` is typed against
    // `z.ZodError` (zod v3). The runtime `issues[]` shape matches;
    // the cast keeps the type-level boundary in one place and avoids
    // forcing each call site to manage the version difference.
    return problemResponse(
      c,
      400,
      'validation',
      'Invalid request',
      mapZodError(result.error as ZodError)
    )
  },
} as const

/**
 * Register the control shared response components against the
 * passed-in `OpenAPIHono`'s registry. Same idempotency boundary as
 * the dashboard registrar — duplicates throw loudly.
 */
export function registerControlResponseComponents<E extends Env>(app: OpenAPIHono<E>): void {
  for (const name of CONTROL_RESPONSE_NAMES) {
    guardDuplicateComponentRegistration(app, 'responses', name)
  }
  app.openAPIRegistry.register('ProblemDetails', controlProblemDetailsSchema)

  for (const name of CONTROL_RESPONSE_NAMES) {
    app.openAPIRegistry.registerComponent('responses', name, {
      description: CONTROL_RESPONSE_DESCRIPTIONS[name],
      content: {
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/ProblemDetails' },
        },
      },
    })
  }
}
