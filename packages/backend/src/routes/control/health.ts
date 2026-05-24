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

import { Hono } from 'hono'

import type { AppEnv } from '../../types.js'

import { getSystemHealth } from '../../services/health.js'
import { controlErrorResponse } from './helpers.js'

export const controlHealthRoutes = new Hono<AppEnv>()

controlHealthRoutes.get('/', async (c) => {
  try {
    const health = await getSystemHealth()
    return c.json(health)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
