/**
 * Dashboard system-health endpoint (issue #109).
 *
 * BetterAuth-session-gated read of the unified system health report. This
 * surface returns the full SystemHealth shape including per-component
 * `detail`, since the audience is logged-in operators using the dashboard
 * card. No project scoping — health is system-wide.
 */

import { Hono } from 'hono'

import type { AppEnv } from '../../types.js'

import { requireSession } from '../../middleware/auth.js'
import { getSystemHealth } from '../../services/health.js'

const healthRoutes = new Hono<AppEnv>()

healthRoutes.use('*', requireSession)

healthRoutes.get('/', async (c) => {
  const health = await getSystemHealth()
  return c.json(health)
})

export { healthRoutes }
