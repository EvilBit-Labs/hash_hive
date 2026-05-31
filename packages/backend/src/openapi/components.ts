/**
 * Shared OpenAPI response components for the dashboard surface.
 *
 * The current hand-rolled `dashboard-api.yaml` declares four named
 * response components (`AuthRequired`, `Forbidden`, `ValidationFailed`,
 * `ResourceNotFound`) and references them via `$ref` at most per-route
 * error responses. This module registers the same components against an
 * `OpenAPIHono` registry so route definitions can reuse them without
 * re-declaring the error envelope shape.
 *
 * **The $ref escape hatch.** `createRoute({ responses: {...} })` expects
 * inline response definitions; the library's documented mechanism to
 * reference a registered shared response is the `{ $ref: '...' } as any`
 * cast (see the @hono/zod-openapi README and the U1 compatibility
 * spike). This module exposes the four `$ref` strings as constants so
 * the cast lives in one place.
 *
 * Control and agent surfaces use different error envelopes (RFC 9457
 * problem-details for control; the agent error envelope for agent) and
 * have their own shared-response modules if/when needed.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from 'hono'

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

export const DASHBOARD_RESPONSE_REFS = {
  AuthRequired: '#/components/responses/AuthRequired',
  Forbidden: '#/components/responses/Forbidden',
  ValidationFailed: '#/components/responses/ValidationFailed',
  ResourceNotFound: '#/components/responses/ResourceNotFound',
} as const

/**
 * Register the four dashboard shared response components against the
 * passed-in `OpenAPIHono`'s registry. Routes reference them via the
 * `DASHBOARD_RESPONSE_REFS` constants and the `as any` $ref cast.
 */
export function registerDashboardResponseComponents<E extends Env>(app: OpenAPIHono<E>): void {
  // Side-effect: registers the schema as a named component too, so the
  // envelope is reusable across responses.
  app.openAPIRegistry.register('DashboardErrorEnvelope', dashboardErrorEnvelopeSchema)

  app.openAPIRegistry.registerComponent('responses', 'AuthRequired', {
    description: 'Authentication required — cookie session missing or expired.',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/DashboardErrorEnvelope' } },
    },
  })
  app.openAPIRegistry.registerComponent('responses', 'Forbidden', {
    description: 'Authenticated but not authorized for the target project or resource.',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/DashboardErrorEnvelope' } },
    },
  })
  app.openAPIRegistry.registerComponent('responses', 'ValidationFailed', {
    description: 'Request body, query, or path parameters failed schema validation.',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/DashboardErrorEnvelope' } },
    },
  })
  app.openAPIRegistry.registerComponent('responses', 'ResourceNotFound', {
    description: 'Target resource does not exist or is outside the caller’s project scope.',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/DashboardErrorEnvelope' } },
    },
  })
}
