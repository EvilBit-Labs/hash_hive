/**
 * Agent configuration service — reads/writes per-rig and fleet-wide config,
 * resolves effective config for the agent API, and validates raw flags.
 *
 * Resolution order for tuning knobs:
 *   per-rig override → fleet default → engine default (undefined / omitted)
 *
 * Hardware knobs are always per-rig; they never inherit from fleet (R5).
 * Error whitelist is the UNION of fleet + per-rig entries, deduped (R12).
 *
 * The pure helpers (validation, merging, JSONB narrowing) live in
 * `agent-config-helpers.ts` so they stay free of `env`/`db` imports and can be
 * unit-tested without triggering env validation at load time. They are
 * re-exported below so existing callers keep resolving them from this module.
 */

import type { AgentConfig, EffectiveAgentConfig, FleetDefaultConfig } from '@hashhive/shared'

import { RAW_FLAG_DENYLIST, agents, fleetAgentConfig } from '@hashhive/shared'
import { and, eq } from 'drizzle-orm'

import { env } from '../config/env.js'
import { db } from '../db/index.js'
import {
  AgentNotFoundError,
  RawFlagValidationError,
  buildMergedAgentConfig,
  buildMergedFleetConfig,
  mergeEffectiveConfig,
  mergeWhitelist,
  parseAgentConfig,
  parseFleetDefaultConfig,
  validateRawFlags,
} from './agent-config-helpers.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'

// Preserve the public surface: routes and the agent API import these error
// types and pure helpers from the service module.
export {
  AgentNotFoundError,
  RawFlagValidationError,
  mergeEffectiveConfig,
  mergeWhitelist,
  validateRawFlags,
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_ACTOR: AuditActor = { actorType: 'system', actorId: null }

// ─── Raw-flag validation ─────────────────────────────────────────────────────

/**
 * Resolve the effective raw-flag denylist for this deployment. The server-level
 * `RAW_FLAG_DENYLIST` env var (operator-owned) REPLACES the built-in default
 * when set; when unset the `@hashhive/shared` default applies. An empty env
 * value resolves to `[]`, disabling the guard (the operator owns that risk).
 */
export function resolveRawFlagDenylist(): readonly string[] {
  return env.RAW_FLAG_DENYLIST ?? RAW_FLAG_DENYLIST
}

// ─── Validate-or-throw helper ─────────────────────────────────────────────────

function assertValidRawFlags(rawFlags: string | undefined): void {
  const result = validateRawFlags(rawFlags, resolveRawFlagDenylist())
  if (!result.ok) {
    throw new RawFlagValidationError(result.code, result.message)
  }
}

// ─── Public service functions ─────────────────────────────────────────────────

/** Read the per-rig config for `agentId`. Defaults to `{}` when unparseable. */
export async function getAgentConfig(agentId: number): Promise<AgentConfig> {
  const [row] = await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return parseAgentConfig(row?.config)
}

/**
 * Read the fleet-wide default config (singleton id=1).
 * Defaults to `{}` when the row is absent or unparseable.
 */
export async function getFleetDefault(): Promise<FleetDefaultConfig> {
  const [row] = await db
    .select({ config: fleetAgentConfig.config })
    .from(fleetAgentConfig)
    .where(eq(fleetAgentConfig.id, 1))
    .limit(1)

  return parseFleetDefaultConfig(row?.config)
}

/**
 * Merge-update the per-rig config for `agentId`.
 * Validates raw flags before writing; records an audit event inside the tx.
 * Throws `AgentNotFoundError` when the agent does not exist.
 * Throws `RawFlagValidationError` when raw flags contain denied entries.
 *
 * When `projectId` is provided, the read-then-write is scoped to that project
 * inside the transaction (same guard as `updateAgent`), closing the TOCTOU
 * window where an agent could be reassigned between the route's ownership
 * check and this write. Omit it for system-actor callers with no project scope.
 */
export async function updateAgentConfig(
  agentId: number,
  patch: AgentConfig,
  actor: AuditActor = DEFAULT_SYSTEM_ACTOR,
  projectId?: number
): Promise<AgentConfig> {
  assertValidRawFlags(patch.tuning?.hashcat?.rawFlags)

  const scope =
    projectId === undefined
      ? eq(agents.id, agentId)
      : and(eq(agents.id, agentId), eq(agents.projectId, projectId))

  const newConfig = await db.transaction(async (tx) => {
    const [oldRow] = await tx.select().from(agents).where(scope).limit(1)

    if (oldRow === undefined) throw new AgentNotFoundError(agentId)

    const oldConfig = parseAgentConfig(oldRow.config)
    const mergedConfig = buildMergedAgentConfig(oldConfig, patch)

    const [updatedRow] = await tx
      .update(agents)
      .set({ config: mergedConfig, updatedAt: new Date() })
      .where(scope)
      .returning()

    if (updatedRow === undefined) throw new AgentNotFoundError(agentId)

    await recordAuditEvent(
      {
        actor,
        projectId: oldRow.projectId,
        entityType: 'agent',
        entityId: agentId,
        action: 'updated',
        oldRow,
        newRow: updatedRow,
      },
      tx
    )

    return parseAgentConfig(updatedRow.config)
  })

  return newConfig
}

/**
 * Merge-update the fleet-wide default config (upsert singleton id=1).
 * Validates raw flags before writing; records an audit event inside the tx.
 * Throws `RawFlagValidationError` when raw flags contain denied entries.
 *
 * `projectId` is `null` because the fleet config is global, not per-project.
 */
export async function updateFleetDefault(
  patch: FleetDefaultConfig,
  actor: AuditActor = DEFAULT_SYSTEM_ACTOR
): Promise<FleetDefaultConfig> {
  assertValidRawFlags(patch.tuning?.hashcat?.rawFlags)

  const newConfig = await db.transaction(async (tx) => {
    // Read the existing row (may be null on first write).
    const [existingRow] = await tx
      .select()
      .from(fleetAgentConfig)
      .where(eq(fleetAgentConfig.id, 1))
      .limit(1)

    const oldConfig = parseFleetDefaultConfig(existingRow?.config)
    const mergedConfig = buildMergedFleetConfig(oldConfig, patch)

    const [upsertedRow] = await tx
      .insert(fleetAgentConfig)
      .values({ id: 1, config: mergedConfig })
      .onConflictDoUpdate({
        target: fleetAgentConfig.id,
        set: { config: mergedConfig, updatedAt: new Date() },
      })
      .returning()

    if (upsertedRow === undefined) {
      throw new Error('Fleet config upsert returned no row')
    }

    await recordAuditEvent(
      {
        actor,
        projectId: null,
        entityType: 'fleet_config',
        entityId: 1,
        action: 'updated',
        oldRow: existingRow ?? null,
        newRow: upsertedRow,
      },
      tx
    )

    return parseFleetDefaultConfig(upsertedRow.config)
  })

  return newConfig
}

/**
 * Resolve the effective tuning + hardware config for `agentId`.
 * Per-knob resolution: per-rig override → fleet default → (omitted).
 * Hardware is always per-rig; it never inherits from the fleet.
 */
export async function resolveEffectiveConfig(agentId: number): Promise<EffectiveAgentConfig> {
  const [perRig, fleet] = await Promise.all([getAgentConfig(agentId), getFleetDefault()])
  return mergeEffectiveConfig(perRig, fleet)
}

/**
 * UNION of fleet + per-rig error whitelist entries, deduped.
 * Used by the server-side whitelist evaluator (U4).
 */
export async function resolveEffectiveWhitelist(agentId: number): Promise<string[]> {
  const [perRig, fleet] = await Promise.all([getAgentConfig(agentId), getFleetDefault()])
  return mergeWhitelist(perRig, fleet)
}
