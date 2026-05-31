/**
 * Shared OpenAPI response components for the dashboard surface.
 *
 * Four named responses (`AuthRequired`, `Forbidden`, `ValidationFailed`,
 * `ResourceNotFound`) are reused on every dashboard error path. Routes
 * reference them via a `$ref` so the error envelope shape is declared
 * in one place rather than inlined on each `createRoute(...)`.
 *
 * **The $ref escape hatch.** `createRoute({ responses: {...} })` expects
 * inline response definitions. The library's documented mechanism to
 * reference a registered shared response is a `$ref` value cast through
 * `unknown` to satisfy the response config type. `sharedResponse(ref)`
 * centralizes that cast so the unsafe boundary lives in one place.
 *
 * Control and agent surfaces use different error envelopes (RFC 9457
 * problem-details for control; the agent error envelope for agent) and
 * will have their own shared-response modules when those surfaces are
 * migrated.
 */

import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { ZodError } from 'zod'

import { z } from '@hono/zod-openapi'

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
}

/**
 * Typed escape hatch for the `$ref` cast. The library's `RouteConfig`
 * response shape expects an inline definition; this wrapper centralizes
 * the `unknown` cast so call sites read
 * `responses: { 401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired) }`
 * instead of replicating `{ $ref: '...' } as any` per route.
 */
type ResponseConfig = NonNullable<RouteConfig['responses'][string]>

export function sharedResponse(ref: DashboardResponseRef): ResponseConfig {
  return { $ref: ref } as unknown as ResponseConfig
}

/**
 * Default validation hook for every dashboard `OpenAPIHono` router.
 * Maps Zod validation failures (request body, query, params, headers)
 * to the dashboard's `{ error: { code: 'VALIDATION_ERROR', message } }`
 * envelope so all dashboard routes keep the same wire shape on bad
 * input. Without this, `@hono/zod-openapi`'s default produces a
 * `{ success: false, error: ZodError }` body that breaks every
 * dashboard-routes test asserting `error.code === 'VALIDATION_ERROR'`.
 *
 * Spread into the constructor:
 *
 *   const router = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)
 *
 * Returns `void` on success so the hook is a no-op and createRoute's
 * normal handler chain continues.
 */
export const dashboardOpenApiHonoOptions = {
  defaultHook: <E extends Env>(
    result: { success: true } | { success: false; error: ZodError },
    c: Context<E>
  ) => {
    if (result.success) return
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues.map((i) => i.message).join('; '),
        },
      },
      400
    )
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
