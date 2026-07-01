/**
 * Pure agent-config helpers — raw-flag validation, config merging, and JSONB
 * narrowing. Split out from `agent-config.ts` so these functions stay free of
 * `env` and `db` imports: importing this module never triggers env validation
 * at load time (the GOTCHAS.md "Pattern B" case), which keeps the pure unit
 * tests env-independent. Env- and DB-aware service code lives in
 * `agent-config.ts`, which re-exports the public surface below.
 */

import {
  type AgentConfig,
  type EffectiveAgentConfig,
  type FleetDefaultConfig,
  RAW_FLAG_DENYLIST,
  RAW_FLAGS_MAX_LEN,
  RAW_FLAGS_MAX_TOKENS,
  agentConfigSchema,
  effectiveAgentConfigSchema,
  fleetDefaultConfigSchema,
} from '@hashhive/shared'

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

// ─── Raw-flag validation ─────────────────────────────────────────────────────

/**
 * Typed error outcome — never throws. Callers that need to surface the error
 * to a user should check `ok` and throw a `RawFlagValidationError` from the
 * returned `code`/`message`.
 *
 * `denylist` defaults to the built-in `RAW_FLAG_DENYLIST` so the function stays
 * pure and unit-testable; the service passes the env-resolved effective list
 * (see `resolveRawFlagDenylist`).
 */
export function validateRawFlags(
  raw: string | undefined,
  denylist: readonly string[] = RAW_FLAG_DENYLIST
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
  // `=` split. Long-flag exact match is intentional: the denylist enumerates
  // every blocked long flag individually, so `--outfile-foo` is permitted
  // unless explicitly listed.
  const shortDenied = denylist.filter(
    (denied) => denied.length === 2 && denied.startsWith('-') && !denied.startsWith('--')
  )
  const longDenied = denylist.filter((denied) => denied.startsWith('--'))

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

export function parseAgentConfig(raw: unknown): AgentConfig {
  const result = agentConfigSchema.safeParse(raw)
  return result.success ? result.data : {}
}

export function parseFleetDefaultConfig(raw: unknown): FleetDefaultConfig {
  const result = fleetDefaultConfigSchema.safeParse(raw)
  return result.success ? result.data : {}
}

// ─── Config merge helpers ─────────────────────────────────────────────────────

/**
 * Produces a new AgentConfig that shallow-merges `patch` into `base`.
 * Within the `tuning.hashcat` sub-object, knobs are merged individually so a
 * partial patch cannot silently wipe sibling knobs.
 */
export function buildMergedAgentConfig(base: AgentConfig, patch: AgentConfig): AgentConfig {
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
export function buildMergedFleetConfig(
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
