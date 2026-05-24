/**
 * DAG (dependency-graph) validators for campaign attacks.
 *
 * Extracted from `services/campaigns.ts` to keep that module under the
 * 800-line guideline. Behavior is unchanged — the pure
 * `validateProposedDAG` (Kahn's algorithm) and its DB-backed
 * `validateCampaignDAG` wrapper just live in a dedicated module now.
 * Callers keep importing through the `services/campaigns.ts` facade.
 */
import { attacks } from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'

/**
 * Pure DAG validator. Operates on an in-memory attack list so write-
 * path callers can validate the *proposed* state (current attacks ±
 * the staged change) before committing to the database. The
 * `validateCampaignDAG` wrapper reads from the DB and delegates here.
 *
 * Returns `{ valid: false, error }` when:
 *   - any dependency references an id outside the input set (covers
 *     cross-campaign references and dangling deps)
 *   - the resulting graph contains a cycle (Kahn's algorithm cannot
 *     drain all nodes)
 */
export function validateProposedDAG(
  proposedAttacks: ReadonlyArray<{ id: number; dependencies: number[] | null }>
): { valid: boolean; error?: string | undefined } {
  if (proposedAttacks.length === 0) {
    return { valid: true }
  }

  const attackIds = new Set(proposedAttacks.map((a) => a.id))

  const inDegree = new Map<number, number>()
  const adjacency = new Map<number, number[]>()

  for (const attack of proposedAttacks) {
    inDegree.set(attack.id, 0)
    adjacency.set(attack.id, [])
  }

  for (const attack of proposedAttacks) {
    const deps = attack.dependencies ?? []
    for (const depId of deps) {
      if (!attackIds.has(depId)) {
        return {
          valid: false,
          error: `Attack ${attack.id} depends on non-existent attack ${depId}`,
        }
      }
      adjacency.get(depId)?.push(attack.id)
      inDegree.set(attack.id, (inDegree.get(attack.id) ?? 0) + 1)
    }
  }

  const queue: number[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id)
    }
  }

  let processed = 0
  while (queue.length > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- queue.length > 0 guarantees non-empty
    const current = queue.shift()!
    processed++

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) {
        queue.push(neighbor)
      }
    }
  }

  if (processed !== proposedAttacks.length) {
    return { valid: false, error: 'Circular dependency detected among attacks' }
  }

  return { valid: true }
}

/**
 * DB-backed campaign DAG validator. Reads the current attack set for
 * the campaign and delegates to `validateProposedDAG`.
 */
export async function validateCampaignDAG(
  campaignId: number
): Promise<{ valid: boolean; error?: string | undefined }> {
  const rows = await db.select().from(attacks).where(eq(attacks.campaignId, campaignId))
  return validateProposedDAG(
    rows.map((a) => ({ id: a.id, dependencies: a.dependencies as number[] | null }))
  )
}
