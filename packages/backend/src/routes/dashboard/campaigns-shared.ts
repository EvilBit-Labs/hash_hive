/**
 * Shared schemas and helpers for the campaigns surface, factored out
 * of `campaigns.ts` so the lifecycle and attack route files can
 * import them without re-creating an import cycle on the main router
 * module.
 */

import type { Context } from 'hono'

import { z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { transitionCampaign, validateCampaignResources } from '../../services/campaigns.js'

export const campaignIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

// Passthrough response shapes; the runtime spec gains entries but the
// schema body stays open until U4's diff against dashboard-api.yaml.
export const campaignRowSchema = z.object({}).passthrough().openapi('Campaign')
export const attackRowSchema = z.object({}).passthrough().openapi('Attack')

export const lifecycleResponseSchema = z.object({
  campaign: campaignRowSchema.nullable(),
})

/**
 * Shared error mapping for `transitionCampaign` results. Keeps the
 * `/lifecycle` action-enum route and the spec-named alias routes in
 * lockstep — every recognized service-layer error code maps to the
 * same HTTP status and envelope across both surfaces. The attack-write
 * paths reuse the same mapping for queue / resource errors so a
 * deferred attack save behaves the same as a lifecycle transition.
 */
export type TransitionResult = Awaited<ReturnType<typeof transitionCampaign>>
export function respondToTransition(c: Context<AppEnv>, result: TransitionResult) {
  if ('error' in result) {
    const code = 'code' in result ? result.code : undefined
    if (code === 'QUEUE_UNAVAILABLE') {
      return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', result.error)
    }
    if (code === 'RESOURCE_VALIDATION_FAILED') {
      // Resource lookup itself failed (DB blip). Surface as 503 so
      // clients can retry rather than treating it as a permanent error.
      return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', result.error)
    }
    if (code === 'RESOURCE_MISSING') {
      // Precondition failed (referenced resource doesn't exist or
      // crosses project boundary). 409 Conflict captures this better
      // than 400 — the request was well-formed, the state isn't.
      return dashboardError(c, 409, 'RESOURCE_MISSING', result.error)
    }
    if (code === 'STALE_STATE') {
      // Optimistic-concurrency loss: another writer transitioned this
      // campaign between our read and write. 409 signals the client
      // should re-fetch and retry against the current state.
      return dashboardError(c, 409, 'STALE_STATE', result.error)
    }
    if (code === 'TASK_GENERATION_FAILED') {
      return dashboardError(c, 500, 'TASK_GENERATION_FAILED', result.error)
    }
    return dashboardError(c, 400, 'INVALID_TRANSITION', result.error)
  }
  return c.json({ campaign: result.campaign })
}

/**
 * Route-layer wrapper around `validateCampaignResources` that turns
 * service throws into the dashboard's `{ error: { code, message } }`
 * envelope. Returns:
 *   - `null` when validation succeeded (caller proceeds)
 *   - a 409 `RESOURCE_MISSING` Response when refs are missing
 *   - a 503 `SERVICE_UNAVAILABLE` Response when the lookup itself
 *     threw (DB blip, query error) — mirrors `transitionCampaign`'s
 *     `RESOURCE_VALIDATION_FAILED` mapping so attack-write paths
 *     have the same retryability semantics as the lifecycle path.
 */
export async function checkResourcesOrErrorResponse(
  c: Context<AppEnv>,
  campaign: { projectId: number; hashListId: number | null },
  attacks: Parameters<typeof validateCampaignResources>[1],
  logContext: { route: string; campaignId: number; projectId: number }
): Promise<Response | null> {
  try {
    const result = await validateCampaignResources(campaign, attacks)
    if (result.valid) return null
    return c.json(
      {
        error: {
          code: 'RESOURCE_MISSING',
          message: `Referenced resources missing: ${result.missing.join(', ')}`,
        },
      },
      409
    )
  } catch (err) {
    logger.error(
      { err, ...logContext },
      'validateCampaignResources threw — surfacing as service unavailable'
    )
    return c.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unable to validate campaign resources right now',
        },
      },
      503
    )
  }
}
