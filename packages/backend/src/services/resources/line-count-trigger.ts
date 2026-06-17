/**
 * Best-effort triggers that enqueue the resource line-count worker (issue #99).
 *
 * Two callers: the chunked-upload completion path (a wordlist/rulelist becomes
 * ready without an inline count) and attack create/update (an attack references
 * a resource that still lacks a count). An enqueue failure must never fail the
 * originating operation, so every entry point swallows errors.
 */

import { maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'

export type LineCountResourceType = 'wordlist' | 'rulelist' | 'masklist'

// Dynamic-import seam so tests can stub the queue access without a live Redis,
// mirroring `services/campaigns.ts`'s `_deps` pattern (bun:test's mock.module
// can't override already-cached dynamic imports across files).
export const _lineCountDeps = {
  getQueueContext: () => import('../../queue/context.js'),
  getQueueConfig: () => import('../../config/queue.js'),
}

/**
 * Enqueue a single line-count job, deduped per resource via a deterministic
 * jobId (`QueueManager.enqueue` auto-pairs the jobId with terminal eviction).
 * Best-effort: a missing queue manager or an enqueue throw is swallowed.
 */
export async function enqueueLineCount(
  resourceType: LineCountResourceType,
  resourceId: number,
  projectId: number
): Promise<void> {
  try {
    const { getQueueManager } = await _lineCountDeps.getQueueContext()
    const { QUEUE_NAMES } = await _lineCountDeps.getQueueConfig()
    const qm = getQueueManager()
    if (!qm) return
    await qm.enqueue(
      QUEUE_NAMES.LINE_COUNT,
      { resourceType, resourceId, projectId },
      { jobId: `linecount:${resourceType}:${resourceId}` }
    )
  } catch (err) {
    logger.warn({ err, resourceType, resourceId }, 'failed to enqueue line-count job')
  }
}

/**
 * For an attack's referenced resources, enqueue a count job for any that still
 * lack the input keyspace computation needs: a wordlist/rulelist without a
 * `lineCount`, or a masklist without a summed `keyspace` (#231). No-op for
 * resources already counted (the common case) and for inline-mask-only attacks.
 * Best-effort end to end.
 */
export async function enqueueLineCountForUncountedResources(attack: {
  wordlistId: number | null
  rulelistId: number | null
  masklistId: number | null
  projectId: number
}): Promise<void> {
  try {
    const checks: Array<[LineCountResourceType, number]> = []
    if (attack.wordlistId !== null) checks.push(['wordlist', attack.wordlistId])
    if (attack.rulelistId !== null) checks.push(['rulelist', attack.rulelistId])
    if (attack.masklistId !== null) checks.push(['masklist', attack.masklistId])

    for (const [resourceType, resourceId] of checks) {
      // A masklist is "uncounted" when its summed keyspace is null; a
      // wordlist/rulelist when its lineCount is null.
      const isUncounted =
        resourceType === 'masklist'
          ? await maskKeyspaceIsNull(resourceId)
          : await lineCountIsNull(resourceType, resourceId)
      if (isUncounted) {
        await enqueueLineCount(resourceType, resourceId, attack.projectId)
      }
    }
  } catch (err) {
    logger.warn({ err }, 'failed to enqueue line-count for attack resources')
  }
}

async function lineCountIsNull(
  resourceType: 'wordlist' | 'rulelist',
  resourceId: number
): Promise<boolean> {
  const table = resourceType === 'wordlist' ? wordLists : ruleLists
  const [row] = await db
    .select({ lineCount: table.lineCount })
    .from(table)
    .where(eq(table.id, resourceId))
    .limit(1)
  return !!row && (row.lineCount === null || row.lineCount === undefined)
}

async function maskKeyspaceIsNull(resourceId: number): Promise<boolean> {
  const [row] = await db
    .select({ keyspace: maskLists.keyspace })
    .from(maskLists)
    .where(eq(maskLists.id, resourceId))
    .limit(1)
  return !!row && (row.keyspace === null || row.keyspace === undefined)
}
