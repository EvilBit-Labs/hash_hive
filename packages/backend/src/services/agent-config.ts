/**
 * Agent configuration service — reads/writes per-rig and fleet-wide config,
 * resolves effective config for the agent API, and validates raw flags.
 *
 * Resolution order for tuning knobs:
 *   per-rig override → fleet default → engine default (undefined / omitted)
 *
 * Hardware knobs are always per-rig; they never inherit from fleet (R5).
 * Error whitelist is the UNION of fleet + per-rig entries, deduped (R12).
 */

import {
  type AgentConfig,
  type EffectiveAgentConfig,
  type FleetDefaultConfig,
  RAW_FLAG_DENYLIST,
  RAW_FLAGS_MAX_LEN,
  RAW_FLAGS_MAX_TOKENS,
  agentConfigSchema,
  agents,
  effectiveAgentConfigSchema,
  fleetAgentConfig,
  fleetDefaultConfigSchema,
} from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'

// ─── Error types ─────────────────────────────────────────────────────────────

export class AgentNotFoundError extends Error {
  constructor(agentId: number) {
    super(`Agent ${agentId} not found`)
    this.name = 'AgentNotFoundError'
  }
}

export class RawFlagValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RawFlagValidationError'
    this.code = code
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_ACTOR: AuditActor = { actorType: 'system', actorId: null }

// ─── Raw-flag validation ─────────────────────────────────────────────────────

/**
 * Typed error outcome — never throws. Callers that need to surface the error
 * to a user should check `ok` and throw a `RawFlagValidationError` from the
 * returned `code`/`message`.
 */
export function validateRawFlags(
  raw: string | undefined
): { ok: true } | { ok: false; code: string; message: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true }

  if (raw.length > RAW_FLAGS_MAX_LEN) {
    return {
      ok: false,
      code: 'RAW_FLAGS_TOO_LONG',
      message: `Raw flags must not exceed ${RAW_FLAGS_MAX_LEN} characters (got ${raw.length})`,
    }
  }

  const tokens = raw.trim().split(/\s+/).filter(Boolean)

  if (tokens.length > RAW_FLAGS_MAX_TOKENS) {
    return {
      ok: false,
      code: 'RAW_FLAGS_TOO_MANY_TOKENS',
      message: `Raw flags must not exceed ${RAW_FLAGS_MAX_TOKENS} tokens (got ${tokens.length})`,
    }
  }

  // Short denied flags (e.g. `-o`) can be written with an attached value
  // (`-o/etc/passwd`), so they are matched by prefix. Long flags (`--flag`)
  // cannot attach a value without `=`, so they are exact-matched after the
  // `=` split. Long-flag exact match is intentional: RAW_FLAG_DENYLIST
  // enumerates every blocked long flag individually, so `--outfile-foo` is
  // permitted unless explicitly listed.
  const shortDenied = RAW_FLAG_DENYLIST.filter(
    (denied) => denied.length === 2 && denied.startsWith('-') && !denied.startsWith('--')
  )
  const longDenied = RAW_FLAG_DENYLIST.filter((denied) => denied.startsWith('--'))

  for (const token of tokens) {
    const flagPart = token.split('=')[0] ?? token

    const deniedEntry =
      longDenied.find((denied) => flagPart === denied) ??
      shortDenied.find((denied) => token.startsWith(denied))
    if (deniedEntry !== undefined) {
      return {
        ok: false,
        code: 'RAW_FLAGS_DENIED',
        message: `Flag "${deniedEntry}" is not permitted`,
      }
    }
  }

  return { ok: true }
}

// ─── Pure resolution helpers ──────────────────────────────────────────────────

/**
 * Merges per-rig and fleet configs into the EffectiveAgentConfig shape.
 * Pure function — exported so unit tests can exercise it without a DB.
 *
 * Tuning: per-rig knobs shadow fleet knobs at the sub-object level (e.g. the
 *   full `hashcat` object from the rig replaces the fleet's, then knobs within
 *   it are individually merged so an unset rig knob inherits from the fleet).
 *
 * Hardware: always from per-rig only (never inherited).
 */
export function mergeEffectiveConfig(
  perRig: AgentConfig,
  fleet: FleetDefaultConfig
): EffectiveAgentConfig {
  const fleetHashcat = fleet.tuning?.hashcat
  const rigHashcat = perRig.tuning?.hashcat

  // Per-knob merge within the hashcat sub-object.
  const mergedHashcat =
    fleetHashcat !== undefined || rigHashcat !== undefined
      ? { ...fleetHashcat, ...rigHashcat }
      : undefined

  const tuning = mergedHashcat !== undefined ? { hashcat: mergedHashcat } : {}

  // effectiveAgentConfigSchema requires both tuning and hardware to be present
  // objects (not optional). Default to {} when the rig has no hardware config.
  return effectiveAgentConfigSchema.parse({
    tuning,
    hardware: perRig.hardware ?? {},
  })
}

/**
 * UNION of fleet + per-rig error whitelist entries, deduped.
 * Pure function exported for unit tests.
 */
export function mergeWhitelist(perRig: AgentConfig, fleet: FleetDefaultConfig): string[] {
  const fleetEntries = fleet.errorWhitelist ?? []
  const rigEntries = perRig.errorWhitelist ?? []
  return [...new Set([...fleetEntries, ...rigEntries])]
}

// ─── JSONB narrowing helpers ──────────────────────────────────────────────────

function parseAgentConfig(raw: unknown): AgentConfig {
  const result = agentConfigSchema.safeParse(raw)
  return result.success ? result.data : {}
}

function parseFleetDefaultConfig(raw: unknown): FleetDefaultConfig {
  const result = fleetDefaultConfigSchema.safeParse(raw)
  return result.success ? result.data : {}
}

// ─── Config merge helpers ─────────────────────────────────────────────────────

/**
 * Produces a new AgentConfig that shallow-merges `patch` into `base`.
 * Within the `tuning.hashcat` sub-object, knobs are merged individually so a
 * partial patch cannot silently wipe sibling knobs.
 */
function buildMergedAgentConfig(base: AgentConfig, patch: AgentConfig): AgentConfig {
  const mergedHashcat =
    base.tuning?.hashcat !== undefined || patch.tuning?.hashcat !== undefined
      ? { ...base.tuning?.hashcat, ...patch.tuning?.hashcat }
      : undefined

  let tuning: AgentConfig['tuning']
  if (base.tuning !== undefined || patch.tuning !== undefined) {
    tuning = mergedHashcat !== undefined ? { hashcat: mergedHashcat } : {}
  }

  let hardware: AgentConfig['hardware']
  if (base.hardware !== undefined || patch.hardware !== undefined) {
    hardware = { ...base.hardware, ...patch.hardware }
  }

  const errorWhitelist = patch.errorWhitelist ?? base.errorWhitelist

  return {
    ...(tuning !== undefined ? { tuning } : {}),
    ...(hardware !== undefined ? { hardware } : {}),
    ...(errorWhitelist !== undefined ? { errorWhitelist } : {}),
  }
}

/**
 * Produces a new FleetDefaultConfig that shallow-merges `patch` into `base`.
 * Hardware is not present on fleet config — only tuning and errorWhitelist.
 */
function buildMergedFleetConfig(
  base: FleetDefaultConfig,
  patch: FleetDefaultConfig
): FleetDefaultConfig {
  const mergedHashcat =
    base.tuning?.hashcat !== undefined || patch.tuning?.hashcat !== undefined
      ? { ...base.tuning?.hashcat, ...patch.tuning?.hashcat }
      : undefined

  let tuning: FleetDefaultConfig['tuning']
  if (base.tuning !== undefined || patch.tuning !== undefined) {
    tuning = mergedHashcat !== undefined ? { hashcat: mergedHashcat } : {}
  }

  const errorWhitelist = patch.errorWhitelist ?? base.errorWhitelist

  return {
    ...(tuning !== undefined ? { tuning } : {}),
    ...(errorWhitelist !== undefined ? { errorWhitelist } : {}),
  }
}

// ─── Validate-or-throw helper ─────────────────────────────────────────────────

function assertValidRawFlags(rawFlags: string | undefined): void {
  const result = validateRawFlags(rawFlags)
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
 */
export async function updateAgentConfig(
  agentId: number,
  patch: AgentConfig,
  actor: AuditActor = DEFAULT_SYSTEM_ACTOR
): Promise<AgentConfig> {
  assertValidRawFlags(patch.tuning?.hashcat?.rawFlags)

  const newConfig = await db.transaction(async (tx) => {
    const [oldRow] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1)

    if (oldRow === undefined) throw new AgentNotFoundError(agentId)

    const oldConfig = parseAgentConfig(oldRow.config)
    const mergedConfig = buildMergedAgentConfig(oldConfig, patch)

    const [updatedRow] = await tx
      .update(agents)
      .set({ config: mergedConfig, updatedAt: new Date() })
      .where(eq(agents.id, agentId))
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
