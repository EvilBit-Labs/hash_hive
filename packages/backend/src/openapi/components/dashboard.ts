/**
 * Dashboard surface OpenAPI plumbing.
 *
 * Six named responses (`AuthRequired`, `Forbidden`, `ValidationFailed`,
 * `ResourceNotFound`, `InternalError`, `ServiceUnavailable`) point at the
 * dashboard's `{ error: { code, message, timestamp?, requestId? } }` envelope.
 *
 * The `sharedDashboardResponse(ref)` wrapper is brand-typed so a
 * dashboard route cannot legally reference a control- or
 * agent-registry response — the brand intersection (see
 * `DashboardResponseRef`) makes the structurally-identical template
 * literal `#/components/responses/Forbidden` unassignable to
 * `ControlResponseRef`'s parallel brand.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { ZodError } from 'zod'

import { z } from '@hono/zod-openapi'

import type { ResponseConfig } from './shared.js'

import { guardDuplicateComponentRegistration } from './shared.js'

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
  'ServiceUnavailable',
] as const

type DashboardResponseName = (typeof DASHBOARD_RESPONSE_NAMES)[number]

/**
 * Per-surface brand on the `$ref` types. Without branding, the template
 * literal `'#/components/responses/${Name}'` is structurally identical
 * across surfaces whenever the underlying name string collides — e.g.
 * both control and agent have `'NotFound'`, so `'#/components/responses/NotFound'`
 * would type-check on either `sharedControlResponse` or `sharedAgentResponse`
 * without the brand. The brand is a unique-symbol intersection type
 * with no runtime cost; the `Object.fromEntries` cast below adds the
 * brand to each ref string at the type level.
 */
declare const __DASHBOARD_REF_BRAND__: unique symbol
export type DashboardResponseRef = `#/components/responses/${DashboardResponseName}` & {
  readonly [__DASHBOARD_REF_BRAND__]: true
}

export const DASHBOARD_RESPONSE_REFS = Object.fromEntries(
  DASHBOARD_RESPONSE_NAMES.map((name) => [name, `#/components/responses/${name}`] as const)
) as {
  readonly [K in DashboardResponseName]: `#/components/responses/${K}` & {
    readonly [__DASHBOARD_REF_BRAND__]: true
  }
}

const DASHBOARD_RESPONSE_DESCRIPTIONS: Record<DashboardResponseName, string> = {
  AuthRequired: 'Authentication required - cookie session missing or expired.',
  Forbidden: 'Authenticated but not authorized for the target project or resource.',
  ValidationFailed: 'Request body, query, or path parameters failed schema validation.',
  ResourceNotFound: "Target resource does not exist or is outside the caller's project scope.",
  InternalError:
    'Unexpected server error - downstream dependency (database, BetterAuth, external service) failed and the request could not be completed.',
  ServiceUnavailable:
    'A required backing service is degraded or offline (e.g., queue or object store unavailable).',
}

/**
 * `$ref` wrapper for dashboard-registry responses. The brand on
 * `DashboardResponseRef` prevents cross-surface `$ref` leakage at
 * compile time.
 */
export function sharedDashboardResponse(ref: DashboardResponseRef): ResponseConfig {
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
