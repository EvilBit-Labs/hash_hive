/**
 * Control API health endpoint.
 *
 * API-key authenticated mirror of the public `/health` probe. Unlike the
 * public surface (which returns the legacy envelope and hides per-
 * component detail), this surface returns the full SystemHealth shape
 * including connection counts, queue depths, and probe durations — the
 * audience here is operators with credentials, not anonymous probes.
 *
 * Errors during probe execution are coerced to `unhealthy` ComponentHealth
 * inside the service, so this route does not need its own try/catch for
 * probe failures. The outer try/catch is kept only as a defensive net for
 * truly unexpected exceptions (e.g., Redis client throwing during
 * iteration), which fall back to the standard Control API RFC9457 envelope.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedResponse,
} from '../../openapi/components.js'
import { getSystemHealth } from '../../services/health.js'
import { controlErrorResponse } from './helpers.js'

export const controlHealthRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const systemHealthSchema = z.object({}).passthrough().openapi('SystemHealth')

const getHealthRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Health'],
  summary: 'System health probe with full per-component detail',
  description:
    'Authenticated operator probe. Returns the full SystemHealth shape including per-component status, connection counts, queue depths, and probe durations.',
  security: [{ ControlApiKey: [] }],
  responses: {
    200: {
      description: 'System health snapshot.',
      content: { 'application/json': { schema: systemHealthSchema } },
    },
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHealthRoutes.openapi(getHealthRoute, async (c) => {
  try {
    const health = await getSystemHealth()
    return c.json(health, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
