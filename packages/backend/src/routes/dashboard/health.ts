/**
 * Dashboard system-health endpoint (issue #109).
 *
 * BetterAuth-session-gated read of the unified system health report. This
 * surface returns the full SystemHealth shape including per-component
 * `detail`, since the audience is logged-in operators using the dashboard
 * card. No project scoping — health is system-wide.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { requireSession } from '../../middleware/auth.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
import { getSystemHealth } from '../../services/health.js'

const healthRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

healthRoutes.use('*', requireSession)

// `SystemHealth` carries a discriminated `ComponentHealth` shape that
// would re-encode awkwardly here; the response schema stays permissive
// (typed top-level keys, untyped `components` values) and the actual
// shape is enforced compile-time by `getSystemHealth()`'s return type.
// /health is operator telemetry, not a contract surface for external
// codegen consumers, so looseness is acceptable.
const systemHealthSchema = z
  .object({
    status: z.string(),
    timestamp: z.string(),
    version: z.string(),
    components: z.record(z.string(), z.unknown()),
  })
  .passthrough()
  .openapi('DashboardSystemHealth')

const getHealthRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Health'],
  summary: 'Authenticated system health snapshot for the dashboard card',
  description:
    'Returns the full system-health envelope (component statuses, durationMs, optional detail) for display in the operator dashboard. Distinct from the unauthenticated /health endpoint used by load balancers in that it carries per-component detail.',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'System health snapshot.',
      content: { 'application/json': { schema: systemHealthSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

healthRoutes.openapi(getHealthRoute, async (c) => {
  const health = await getSystemHealth()
  return c.json(health, 200)
})

export { healthRoutes }
