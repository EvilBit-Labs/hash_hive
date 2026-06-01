/**
 * Shared OpenAPI response components for the dashboard and control
 * surfaces. (Agent surface still inlines its envelope today; it will
 * grow its own shared-response set when the agent error envelope is
 * promoted out of inline route definitions.)
 *
 * **Dashboard surface.** Five named responses (`AuthRequired`,
 * `Forbidden`, `ValidationFailed`, `ResourceNotFound`, `InternalError`)
 * point at the dashboard's `{ error: { code, message } }` envelope.
 *
 * **Control surface.** Seven named responses (`AuthError`, `Forbidden`,
 * `NotFound`, `ValidationError`, `Conflict`, `InternalError`,
 * `ServiceUnavailable`) point at the RFC 9457 problem-details
 * envelope. Names mirror the pre-deletion `packages/openapi/control-api.yaml`
 * for stable client codegen output across the route-as-spec cutover.
 *
 * **The $ref escape hatch.** `createRoute({ responses: {...} })` expects
 * inline response definitions. The library's documented mechanism to
 * reference a registered shared response is a `$ref` value cast through
 * `unknown` to satisfy the response config type. The split
 * `sharedDashboardResponse(ref)` / `sharedControlResponse(ref)`
 * helpers centralize that cast (one per surface) so the unsafe
 * boundary lives in one place AND cross-surface `$ref` leaks are a
 * compile error instead of a runtime miss.
 *
 * Agent surface uses a different envelope (the agent error shape) and
 * will get its own shared-response component set when that surface is
 * migrated.
 */

import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { ZodError } from 'zod'

import { z } from '@hono/zod-openapi'

import { mapZodError, problemResponse } from '../lib/problem-details.js'

/**
 * Dashboard error envelope. Mirrors what every dashboard route returns
 * on a failure: `{ error: { code, message, timestamp?, requestId? } }`.
 */
const dashboardErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string().describe('Machine-readable error code (e.g. AUTH_TOKEN_INVALID)'),
      message: z.string(),
      timestamp: z.string().datetime().optional(),
      requestId: z.string().optional(),
    }),
  })
  .openapi('DashboardErrorEnvelope')

/**
 * Single source of truth for the registered response component names.
 * The `registerDashboardResponseComponents` loop iterates over this
 * array, and `DASHBOARD_RESPONSE_REFS` is derived from it — a typo in
 * either site is a compile error rather than a runtime `$ref` lookup
 * failure at spec consumption.
 */
const DASHBOARD_RESPONSE_NAMES = [
  'AuthRequired',
  'Forbidden',
  'ValidationFailed',
  'ResourceNotFound',
  'InternalError',
] as const

type DashboardResponseName = (typeof DASHBOARD_RESPONSE_NAMES)[number]

export type DashboardResponseRef = `#/components/responses/${DashboardResponseName}`

export const DASHBOARD_RESPONSE_REFS = Object.fromEntries(
  DASHBOARD_RESPONSE_NAMES.map((name) => [name, `#/components/responses/${name}`] as const)
) as { readonly [K in DashboardResponseName]: `#/components/responses/${K}` }

const DASHBOARD_RESPONSE_DESCRIPTIONS: Record<DashboardResponseName, string> = {
  AuthRequired: 'Authentication required - cookie session missing or expired.',
  Forbidden: 'Authenticated but not authorized for the target project or resource.',
  ValidationFailed: 'Request body, query, or path parameters failed schema validation.',
  ResourceNotFound: "Target resource does not exist or is outside the caller's project scope.",
  InternalError:
    'Unexpected server error - downstream dependency (database, BetterAuth, external service) failed and the request could not be completed.',
}

/**
 * Typed escape hatch for the `$ref` cast. The library's `RouteConfig`
 * response shape expects an inline definition; this wrapper centralizes
 * the `unknown` cast so call sites read
 * `responses: { 401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired) }`
 * instead of replicating `{ $ref: '...' } as any` per route.
 */
type ResponseConfig = NonNullable<RouteConfig['responses'][string]>

/**
 * Surface-specific `$ref` wrappers. Split (rather than a single
 * single `sharedResponse(ref: DashboardRef | ControlRef)`) so a dashboard
 * route can't legally reference a control-registry response (or vice
 * versa) — the runtime guard at `guardDuplicateComponentRegistration`
 * only catches duplicate registration, not bad referencing, so the
 * compile-time split is the only place that cross-surface
 * `$ref` leaks get prevented. When the agent surface migrates, add a
 * sibling `sharedAgentResponse` rather than widening these unions.
 */
export function sharedDashboardResponse(ref: DashboardResponseRef): ResponseConfig {
  return { $ref: ref } as unknown as ResponseConfig
}

export function sharedControlResponse(ref: ControlResponseRef): ResponseConfig {
  return { $ref: ref } as unknown as ResponseConfig
}

/**
 * Default validation hook for every dashboard `OpenAPIHono` router.
 * Maps Zod validation failures (request body, query, params, headers)
 * to the dashboard's `{ error: { code: 'VALIDATION_ERROR', message } }`
 * envelope so all dashboard routes keep the same wire shape on bad
 * input. Without this, `@hono/zod-openapi`'s default produces a
 * `{ success: false, error: ZodError }` body that breaks every
 * dashboard-routes test asserting `error.code === 'VALIDATION_ERROR'`
 * (see `tests/unit/dashboard-resources-routes.test.ts`,
 * `dashboard-campaigns-routes.test.ts`, and
 * `dashboard-stats-routes.test.ts` for representative anchors).
 *
 * **Message shape.** Each failing issue's `path` (`['query', 'limit']`,
 * `['body', 'name']`, etc.) is joined with `.` and prefixed before the
 * issue message, then issues are joined with `'; '`. Path-less issues
 * (rare; usually a refine on the root object) carry the bare message.
 * This lets consumers programmatically discriminate `query.limit: ...`
 * from `body.name: ...` instead of getting a flat semicolon-soup.
 *
 * **Security note.** Issue `message` strings are emitted verbatim. Any
 * Zod schema on the dashboard surface that uses `.refine` /
 * `.superRefine` MUST NOT interpolate server-side config / env values
 * (e.g. internal secrets, file paths) into the message — they will
 * land in client-visible 400 bodies.
 *
 * **Conventions adopted alongside this hook** for every dashboard
 * `createRoute(...)` + `router.openapi(route, handler)` registration:
 *  - `middleware: [requireXxx(), ...] as const` — the `as const` is
 *    required by `@hono/zod-openapi` to preserve middleware tuple
 *    typing so `c.get('scopedUser')` narrows inside handlers.
 *  - `c.json(body, 200)` — the explicit status arg is required by the
 *    library for response-type narrowing against the route's
 *    `responses[200]` schema; omitting it falls back to a widened
 *    return type that defeats compile-time response-shape checking.
 *
 * Spread into the constructor:
 *
 *   const router = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)
 *
 * Returns `undefined` on success so the hook is a no-op and
 * createRoute's normal handler chain continues.
 */
export const dashboardOpenApiHonoOptions = {
  defaultHook: <E extends Env>(
    result: { success: true } | { success: false; error: ZodError },
    c: Context<E>
  ): Response | undefined => {
    if (result.success) return undefined
    const message = result.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join('.') : ''
        return path ? `${path}: ${i.message}` : i.message
      })
      .join('; ')
    return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400)
  },
} as const

/**
 * Register the dashboard shared response components against the
 * passed-in `OpenAPIHono`'s registry. Throws on duplicate registration
 * so a future caller that accidentally wires two surfaces onto the
 * same registry fails loudly instead of silently last-writer-wins.
 *
 * The named-schema register (`DashboardErrorEnvelope`) is not guarded
 * directly because it always lands before the responses loop on the
 * first call, and the responses guard fires on the second call before
 * the schema re-register can land. The function as a whole is the
 * idempotency boundary.
 */
export function registerDashboardResponseComponents<E extends Env>(app: OpenAPIHono<E>): void {
  for (const name of DASHBOARD_RESPONSE_NAMES) {
    guardDuplicateComponentRegistration(app, 'responses', name)
  }
  app.openAPIRegistry.register('DashboardErrorEnvelope', dashboardErrorEnvelopeSchema)

  for (const name of DASHBOARD_RESPONSE_NAMES) {
    app.openAPIRegistry.registerComponent('responses', name, {
      description: DASHBOARD_RESPONSE_DESCRIPTIONS[name],
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/DashboardErrorEnvelope' } },
      },
    })
  }
}

/**
 * Throws when a `responses` or `securitySchemes` component with the
 * given name is already registered on the surface's registry. The
 * underlying `@asteasolutions/zod-to-openapi` registry silently
 * overwrites duplicates — that is the failure class we want to make
 * loud. Today each surface owns an isolated registry so this guard
 * fires only on misuse; tomorrow if anyone mounts an `OpenAPIHono`
 * child onto an `OpenAPIHono` parent and both register `AuthRequired`,
 * the second call dies at boot rather than shipping a spec with one
 * definition silently missing.
 */
function guardDuplicateComponentRegistration<E extends Env>(
  app: OpenAPIHono<E>,
  componentType: 'responses' | 'securitySchemes',
  name: string
): void {
  const definitions = (
    app.openAPIRegistry as unknown as {
      definitions: Array<{
        type: 'schema' | 'component' | 'route' | 'parameter' | 'webhook'
        componentType?: string
        name?: string
      }>
    }
  ).definitions
  for (const def of definitions) {
    if (def.type === 'component' && def.componentType === componentType && def.name === name) {
      throw new Error(
        `[openapi] Duplicate ${componentType} registration: '${name}' is already registered on this surface. ` +
          'Two surfaces (dashboard / control / agent) must not share an OpenAPIHono registry.'
      )
    }
  }
}

/**
 * Exposed for unit testing the duplicate guard. Production code paths
 * should use `registerDashboardResponseComponents` instead.
 */
export { guardDuplicateComponentRegistration as _guardDuplicateComponentRegistrationForTest }

// ─── Control surface: RFC 9457 problem-details ──────────────────────

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

/**
 * Names mirror the pre-deletion `packages/openapi/control-api.yaml`
 * `components.responses` keys so client codegen output stays stable
 * across the route-as-spec cutover (plan D7).
 */
const CONTROL_RESPONSE_NAMES = [
  'AuthError',
  'Forbidden',
  'NotFound',
  'ValidationError',
  'Conflict',
  'InternalError',
  'ServiceUnavailable',
] as const

type ControlResponseName = (typeof CONTROL_RESPONSE_NAMES)[number]

export type ControlResponseRef = `#/components/responses/${ControlResponseName}`

export const CONTROL_RESPONSE_REFS = Object.fromEntries(
  CONTROL_RESPONSE_NAMES.map((name) => [name, `#/components/responses/${name}`] as const)
) as { readonly [K in ControlResponseName]: `#/components/responses/${K}` }

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
    return problemResponse(c, 400, 'validation', 'Invalid request', mapZodError(result.error))
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
