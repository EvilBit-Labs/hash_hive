/**
 * Attack complexity: keyspace computation/persistence and the progressive ETA.
 *
 * Keyspace is persisted to `attacks.keyspace` because task generation consumes
 * the stored value (`generateTasksForAttack`) and computing it needs I/O
 * (resource line counts). Attack *status* and ETA, by contrast, are derived at
 * read time in the campaign detail payload. The keyspace calculator itself
 * (`services/keyspace.ts`) stays pure; this module wires it to the DB: resolve
 * resource line counts, persist, and fan out to dependent attacks.
 */

import { attacks, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import { db } from '../../db/index.js'
import { type CalculateAttackKeyspaceInput, calculateAttackKeyspace } from '../keyspace.js'
import { jsonSafeBigint } from './_internals.js'

/** The persisted attack fields needed to resolve a keyspace. */
export interface AttackKeyspaceInput {
  mode: number
  wordlistId: number | null
  rulelistId: number | null
  masklistId: number | null
  advancedConfiguration: unknown
}

/**
 * Resolve the keyspace inputs for an attack by joining its wordlist / rulelist
 * line counts and reading the mask string from `advancedConfiguration.mask`.
 * Shared by task generation and create/update-time persistence so the two
 * cannot drift.
 *
 * Mode 1 (combination) has no schema field for a second wordlist, so
 * `secondaryWordlistRows` stays undefined and combination attacks fall through
 * to the single-task path until that field exists. A mode-3 attack referencing
 * a masklist file (one mask per line) uses the masklist's precomputed summed
 * keyspace (`mask_lists.keyspace`, #231); an inline `advancedConfiguration.mask`
 * takes precedence when both are somehow present.
 */
export async function loadKeyspaceInputs(
  attack: AttackKeyspaceInput
): Promise<CalculateAttackKeyspaceInput> {
  const inputs: CalculateAttackKeyspaceInput = { mode: attack.mode }

  if (attack.wordlistId !== null) {
    const [row] = await db
      .select({ lineCount: wordLists.lineCount })
      .from(wordLists)
      .where(eq(wordLists.id, attack.wordlistId))
      .limit(1)
    if (row?.lineCount !== null && row?.lineCount !== undefined) inputs.wordlistRows = row.lineCount
  }
  if (attack.rulelistId !== null) {
    const [row] = await db
      .select({ lineCount: ruleLists.lineCount })
      .from(ruleLists)
      .where(eq(ruleLists.id, attack.rulelistId))
      .limit(1)
    if (row?.lineCount !== null && row?.lineCount !== undefined) inputs.rulelistRows = row.lineCount
  }
  if (attack.advancedConfiguration && typeof attack.advancedConfiguration === 'object') {
    const cfg = attack.advancedConfiguration as Record<string, unknown>
    if (typeof cfg['mask'] === 'string') inputs.mask = cfg['mask']
  }
  // A masklist-backed mode-3 attack (no inline mask) reads the masklist's
  // precomputed summed keyspace. Null when uncomputable or not yet counted.
  if (inputs.mask === undefined && attack.masklistId !== null) {
    const [row] = await db
      .select({ keyspace: maskLists.keyspace })
      .from(maskLists)
      .where(eq(maskLists.id, attack.masklistId))
      .limit(1)
    if (row?.keyspace !== null && row?.keyspace !== undefined)
      inputs.masklistKeyspace = row.keyspace
  }
  return inputs
}

/**
 * Compute an attack's total keyspace as a decimal string, or null when inputs
 * are incomplete (missing line count / unknown mode / unsupported mask token).
 * Accepts undefined ids (from create/update payloads) as null.
 */
export async function computeAttackKeyspace(attack: {
  mode: number
  wordlistId?: number | null | undefined
  rulelistId?: number | null | undefined
  masklistId?: number | null | undefined
  advancedConfiguration?: unknown
}): Promise<string | null> {
  const inputs = await loadKeyspaceInputs({
    mode: attack.mode,
    wordlistId: attack.wordlistId ?? null,
    rulelistId: attack.rulelistId ?? null,
    masklistId: attack.masklistId ?? null,
    advancedConfiguration: attack.advancedConfiguration ?? null,
  })
  return calculateAttackKeyspace(inputs)
}

/**
 * Compute and persist `attacks.keyspace` for a single attack, returning the
 * computed value (null when uncomputable). The column is set to the computed
 * value — including null — so it always reflects the attack's current inputs.
 */
export async function persistAttackKeyspace(attack: {
  id: number
  mode: number
  wordlistId: number | null
  rulelistId: number | null
  masklistId: number | null
  advancedConfiguration: unknown
}): Promise<string | null> {
  const keyspace = await computeAttackKeyspace(attack)
  await db.update(attacks).set({ keyspace, updatedAt: new Date() }).where(eq(attacks.id, attack.id))
  return keyspace
}

/**
 * Recompute and persist keyspace for every attack referencing a resource,
 * after that resource's keyspace input becomes known (direct upload or the
 * async line-count worker). Counted once per resource; the recompute fans out
 * to all dependents. Wordlist/rulelist fan out via their line count; a masklist
 * fans out via its summed keyspace (#231) to dependent mode-3 attacks.
 */
export async function recomputeKeyspaceForResource(
  resourceType: 'wordlist' | 'rulelist' | 'masklist',
  resourceId: number
): Promise<void> {
  const column =
    resourceType === 'wordlist'
      ? attacks.wordlistId
      : resourceType === 'rulelist'
        ? attacks.rulelistId
        : attacks.masklistId
  const dependents = await db
    .select({
      id: attacks.id,
      mode: attacks.mode,
      wordlistId: attacks.wordlistId,
      rulelistId: attacks.rulelistId,
      masklistId: attacks.masklistId,
      advancedConfiguration: attacks.advancedConfiguration,
    })
    .from(attacks)
    .where(eq(column, resourceId))
  await Promise.all(dependents.map((attack) => persistAttackKeyspace(attack)))
}

// Fixed-point scale for the (1 - fractionDone) multiplier — six decimal places
// of fraction precision, applied in bigint so huge keyspaces keep precision.
const FRACTION_SCALE = 1_000_000n

/**
 * Estimated seconds remaining on an attack — an ETA (time left), counting
 * down — or null when uncomputable. Before any work runs (`fractionDone` = 0)
 * this is the full a-priori estimate `keyspace / Σ speedHs`; as the keyspace is
 * covered it shrinks toward 0.
 *
 * Deriving remaining work from keyspace coverage and the current fleet rate
 * (not wall-clock elapsed) is what keeps a preempted attack's ETA stable: a
 * paused attack has frozen `fractionDone` and a current fleet rate, so its ETA
 * does not inflate over the pause window.
 *
 * Returned via {@link jsonSafeBigint} (number | string) so an astronomically
 * slow mask attack whose ETA exceeds Number.MAX_SAFE_INTEGER seconds survives
 * the wire intact.
 */
export function estimateSecondsRemaining(args: {
  keyspace: string | null
  fractionDone: number
  benchmarks: ReadonlyArray<{ speedHs: number }>
}): number | string | null {
  const { keyspace, fractionDone, benchmarks } = args
  if (keyspace === null) return null

  let total: bigint
  try {
    total = BigInt(keyspace)
  } catch {
    return null
  }
  if (total <= 0n) return null

  // Fleet throughput = sum of positive, finite agent speeds (work is parallel).
  const speedSum = benchmarks.reduce(
    (sum, b) => (Number.isFinite(b.speedHs) && b.speedHs > 0 ? sum + b.speedHs : sum),
    0
  )
  if (speedSum <= 0) return null

  // remaining = total * (1 - clamp(fractionDone)) via fixed-point bigint math.
  const clamped = Number.isFinite(fractionDone) ? Math.min(Math.max(fractionDone, 0), 1) : 0
  const remainingFraction = BigInt(Math.round((1 - clamped) * Number(FRACTION_SCALE)))
  const remaining = (total * remainingFraction) / FRACTION_SCALE
  if (remaining <= 0n) return 0

  // ceil(remaining / speedSum) in bigint; a sub-1 h/s fleet floors to 1 h/s.
  const speed = BigInt(Math.max(1, Math.floor(speedSum)))
  const seconds = (remaining + speed - 1n) / speed
  return jsonSafeBigint(seconds)
}
