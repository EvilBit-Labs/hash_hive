/**
 * Dashboard agent-configuration routes (#104 U5).
 *
 * Exposes per-rig and fleet-wide config read/write for the dashboard
 * surface. All reads require a valid session + project access; writes
 * require at least contributor membership. Fleet-wide writes are gated
 * to global `admin` role (R17).
 *
 * Source-map computation (R11):
 *   For each tuning knob, the resolution order is:
 *     per-rig override → fleet default → engine default
 *   The returned `sources` map carries 'override' when the rig has an
 *   explicit value, 'fleet' when only the fleet has a value, and
 *   'engine' when neither side sets the knob.
 *
 *   Hardware knobs are always per-rig (R5); they map to 'override' when
 *   present, 'engine' when absent.
 *
 *   `errorWhitelist` follows the same override/fleet/engine logic —
 *   the source reflects where the array value comes from, not the
 *   merged union (which is resolved separately for server-side evaluation).
 */

import {
  agentConfigResponseSchema,
  agentConfigSchema,
  fleetConfigResponseSchema,
  fleetDefaultConfigSchema,
  type AgentConfig,
  type ConfigValueSource,
  type FleetDefaultConfig,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess, requireRole } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import {
  AgentNotFoundError,
  RawFlagValidationError,
  getAgentConfig,
  getFleetDefault,
  mergeEffectiveConfig,
  updateAgentConfig,
  updateFleetDefault,
} from '../../services/agent-config.js'
import { getAgentById } from '../../services/agents.js'

const dashboardAgentConfigRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// This router mounts at '/' on the dashboard surface, so wildcard middleware
// would intercept every dashboard request (including /events/stream WS upgrades).
// Apply requireSession per-path instead.
dashboardAgentConfigRoutes.use('/agents/:id/config', requireSession)
dashboardAgentConfigRoutes.use('/fleet-agent-config', requireSession)

// ─── Param schema (shared across agent-scoped routes) ─────────────────

const agentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

// ─── Source-map computation (R11) ─────────────────────────────────────

/**
 * Derive the resolution source for a single knob value.
 * Returns 'override' when the rig has an explicit value, 'fleet' when
 * only the fleet has a value, and 'engine' when neither is set.
 */
function resolveKnobSource(rigValue: unknown, fleetValue: unknown): ConfigValueSource | undefined {
  if (rigValue !== undefined) return 'override'
  if (fleetValue !== undefined) return 'fleet'
  return undefined
}

/**
 * Compute the per-knob source map from the per-rig and fleet configs.
 * Pure function so it can be unit-tested independently.
 */
function computeSourceMap(
  perRig: AgentConfig,
  fleet: FleetDefaultConfig
): z.infer<typeof agentConfigResponseSchema>['sources'] {
  const rigHashcat = perRig.tuning?.hashcat
  const fleetHashcat = fleet.tuning?.hashcat

  // Only emit a tuning section when at least one side has a hashcat
  // sub-object — avoids emitting `{ tuning: {} }` for a rig with no
  // config at all.
  const hasHashcatKnobs =
    rigHashcat !== undefined ||
    fleetHashcat !== undefined ||
    perRig.tuning !== undefined ||
    fleet.tuning !== undefined

  const hashcatSources = hasHashcatKnobs
    ? {
        ...(resolveKnobSource(rigHashcat?.workloadProfile, fleetHashcat?.workloadProfile) !==
          undefined && {
          workloadProfile: resolveKnobSource(
            rigHashcat?.workloadProfile,
            fleetHashcat?.workloadProfile
          )!,
        }),
        ...(resolveKnobSource(rigHashcat?.kernelAccel, fleetHashcat?.kernelAccel) !== undefined && {
          kernelAccel: resolveKnobSource(rigHashcat?.kernelAccel, fleetHashcat?.kernelAccel)!,
        }),
        ...(resolveKnobSource(rigHashcat?.kernelLoops, fleetHashcat?.kernelLoops) !== undefined && {
          kernelLoops: resolveKnobSource(rigHashcat?.kernelLoops, fleetHashcat?.kernelLoops)!,
        }),
        ...(resolveKnobSource(rigHashcat?.rawFlags, fleetHashcat?.rawFlags) !== undefined && {
          rawFlags: resolveKnobSource(rigHashcat?.rawFlags, fleetHashcat?.rawFlags)!,
        }),
      }
    : undefined

  const tuningSources =
    hashcatSources !== undefined && Object.keys(hashcatSources).length > 0
      ? { hashcat: hashcatSources }
      : hasHashcatKnobs
        ? {}
        : undefined

  // Hardware knobs are always per-rig (R5). 'override' when set, nothing emitted when absent.
  const rigHardware = perRig.hardware
  const hardwareSources =
    rigHardware !== undefined
      ? {
          ...(rigHardware.deviceIds !== undefined && { deviceIds: 'override' as const }),
          ...(rigHardware.tempAbort !== undefined && { tempAbort: 'override' as const }),
        }
      : undefined

  const hasHardwareSource = hardwareSources !== undefined && Object.keys(hardwareSources).length > 0

  const whitelistSource = resolveKnobSource(perRig.errorWhitelist, fleet.errorWhitelist)

  return {
    ...(tuningSources !== undefined && { tuning: tuningSources }),
    ...(hasHardwareSource && { hardware: hardwareSources }),
    ...(whitelistSource !== undefined && { errorWhitelist: whitelistSource }),
  }
}

// ─── GET /agents/:id/config ───────────────────────────────────────────

dashboardAgentConfigRoutes.use('/agents/:id/config', requireProjectAccess())

const getAgentConfigRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/config',
  tags: ['Agent Config'],
  summary: 'Get per-rig configuration with effective values and source map',
  security: [{ SessionCookie: [] }],
  request: { params: agentIdParamSchema },
  responses: {
    200: {
      description: 'Per-rig config, effective values, and per-knob source map.',
      content: { 'application/json': { schema: agentConfigResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentConfigRoutes.openapi(getAgentConfigRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId } = c.get('currentUser')

  // GOTCHAS:21 — requireProjectAccess checks session membership but
  // does NOT validate sub-resource ownership. Fetch the agent and
  // assert project scope explicitly so a member of project A cannot
  // read an agent that belongs to project B.
  const agent = await getAgentById(agentId)
  if (!agent || agent.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }

  const [perRig, fleet] = await Promise.all([getAgentConfig(agentId), getFleetDefault()])
  const effective = mergeEffectiveConfig(perRig, fleet)
  const sources = computeSourceMap(perRig, fleet)

  return c.json({ config: perRig, effective, sources }, 200)
})

// ─── PATCH /agents/:id/config ─────────────────────────────────────────

const patchAgentConfigRoute = createRoute({
  method: 'patch',
  path: '/agents/{id}/config',
  tags: ['Agent Config'],
  summary: 'Merge-update per-rig configuration (admin / contributor only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: agentIdParamSchema,
    body: { content: { 'application/json': { schema: agentConfigSchema } } },
  },
  responses: {
    200: {
      description: 'Updated per-rig config with effective values and source map.',
      content: { 'application/json': { schema: agentConfigResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

dashboardAgentConfigRoutes.openapi(patchAgentConfigRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const patch = c.req.valid('json')
  // `currentUser` (populated by requireSession) is the always-present context
  // var and carries both projectId and userId — same source the GET handler
  // reads. Avoids the `scopedUser!` non-null assertion.
  const { projectId, userId } = c.get('currentUser')

  // Sub-resource ownership check — same pattern as agents.ts PATCH /:id.
  const agent = await getAgentById(agentId)
  if (!agent || agent.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }

  try {
    // Pass projectId so the write is project-scoped inside the service tx,
    // closing the TOCTOU window after the ownership check above.
    const updated = await updateAgentConfig(
      agentId,
      patch,
      { actorType: 'user', actorId: userId },
      projectId
    )
    const fleet = await getFleetDefault()
    const effective = mergeEffectiveConfig(updated, fleet)
    const sources = computeSourceMap(updated, fleet)
    return c.json({ config: updated, effective, sources }, 200)
  } catch (err) {
    if (err instanceof RawFlagValidationError) {
      return dashboardError(c, 400, 'RAW_FLAG_INVALID', err.message)
    }
    if (err instanceof AgentNotFoundError) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
    }
    logger.error(
      { err, agentId, projectId, userId, op: 'updateAgentConfig' },
      'agent-config: update failed'
    )
    return dashboardError(c, 500, 'AGENT_CONFIG_UPDATE_FAILED', 'Failed to update agent config')
  }
})

// ─── GET /fleet-agent-config ──────────────────────────────────────────

dashboardAgentConfigRoutes.use('/fleet-agent-config', requireProjectAccess())

const getFleetConfigRoute = createRoute({
  method: 'get',
  path: '/fleet-agent-config',
  tags: ['Agent Config'],
  summary: 'Get fleet-wide default configuration',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'Fleet-wide default config.',
      content: { 'application/json': { schema: fleetConfigResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

dashboardAgentConfigRoutes.openapi(getFleetConfigRoute, async (c) => {
  const config = await getFleetDefault()
  return c.json({ config }, 200)
})

// ─── PATCH /fleet-agent-config ────────────────────────────────────────
//
// Global admin guard (R17): fleet config is a system-wide knob that
// affects all rigs across all projects. Uses `requireRole('admin')`
// (global capability tier) not `requireMembershipRole` (per-project).

const patchFleetConfigRoute = createRoute({
  method: 'patch',
  path: '/fleet-agent-config',
  tags: ['Agent Config'],
  summary: 'Merge-update fleet-wide default configuration (global admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    body: { content: { 'application/json': { schema: fleetDefaultConfigSchema } } },
  },
  responses: {
    200: {
      description: 'Updated fleet-wide default config.',
      content: { 'application/json': { schema: fleetConfigResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

dashboardAgentConfigRoutes.openapi(patchFleetConfigRoute, async (c) => {
  const patch = c.req.valid('json')
  const { userId } = c.get('currentUser')

  try {
    const updated = await updateFleetDefault(patch, {
      actorType: 'user',
      actorId: userId,
    })
    return c.json({ config: updated }, 200)
  } catch (err) {
    if (err instanceof RawFlagValidationError) {
      return dashboardError(c, 400, 'RAW_FLAG_INVALID', err.message)
    }
    logger.error({ err, userId, op: 'updateFleetDefault' }, 'agent-config: fleet update failed')
    return dashboardError(c, 500, 'FLEET_CONFIG_UPDATE_FAILED', 'Failed to update fleet config')
  }
})

export { dashboardAgentConfigRoutes }
export { computeSourceMap }
