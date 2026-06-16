/**
 * Backfill script: compute and persist the summed keyspace for masklists that
 * were uploaded before masklist-keyspace support landed (issue #231).
 *
 * The upload-triggered worker only fires on new uploads, so already-uploaded
 * masklists keep a null `keyspace` (and their mode-3 attacks keep a null
 * `attacks.keyspace`) until something re-touches them. This one-shot streams
 * each such masklist, sums its per-line mask keyspace, persists it, and fans
 * the recompute out to dependent attacks — the same work the worker does, run
 * inline so no Redis/worker is required.
 *
 * Idempotent — only masklists with a file reference and a null keyspace are
 * processed, so re-running re-counts only still-null rows.
 *
 * Usage:
 *   bun packages/backend/src/scripts/backfill-masklist-keyspace.ts
 */
import { maskLists } from '@hashhive/shared'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { client, db } from '../db/index.js'
import { recomputeKeyspaceForResource } from '../services/attacks/complexity.js'
import { sumMasklistKeyspace } from '../services/keyspace.js'
import { MAX_LINE_LENGTH, streamLines } from '../services/resources/line-count.js'

async function backfill(): Promise<void> {
  const rows = await db
    .select({ id: maskLists.id, fileRef: maskLists.fileRef })
    .from(maskLists)
    .where(and(isNull(maskLists.keyspace), isNotNull(maskLists.fileRef)))

  logger.info({ count: rows.length }, 'masklist keyspace backfill: candidates found')

  let computed = 0
  let skipped = 0
  for (const row of rows) {
    const fileRef = row.fileRef as { bucket?: string; key?: string } | null
    if (!fileRef?.key) {
      skipped++
      continue
    }

    const lines: string[] = []
    for await (const line of streamLines(fileRef.key, fileRef.bucket)) lines.push(line)
    const keyspace = sumMasklistKeyspace(lines, MAX_LINE_LENGTH)

    await db
      .update(maskLists)
      .set({ keyspace, updatedAt: new Date() })
      .where(eq(maskLists.id, row.id))
    await recomputeKeyspaceForResource('masklist', row.id)

    if (keyspace !== null) computed++
    logger.info({ masklistId: row.id, keyspace }, 'masklist keyspace backfilled')
  }

  logger.info(
    { total: rows.length, computed, uncomputableOrSkipped: rows.length - computed },
    'masklist keyspace backfill complete'
  )
  if (skipped > 0) {
    logger.warn({ skipped }, 'masklist keyspace backfill: rows skipped (no file reference)')
  }
}

backfill()
  .then(() => client.end())
  .catch(async (err) => {
    logger.error({ err }, 'masklist keyspace backfill failed')
    await client.end()
    process.exit(1)
  })
