/**
 * Backfill script: compute and persist the summed keyspace for masklists that
 * were uploaded before masklist-keyspace support landed (issue #231).
 *
 * The upload-triggered worker only fires on new uploads, so already-uploaded
 * masklists keep a null `keyspace` (and their mode-3 attacks keep a null
 * `attacks.keyspace`) until something re-touches them. This one-shot streams
 * each such masklist, sums its per-line mask keyspace, persists it, and fans
 * the recompute out to dependent attacks — the same work the worker does (via
 * the shared `computeAndPersistMasklistKeyspace`), run inline so no Redis or
 * worker is required.
 *
 * Idempotent — only masklists with a file reference and a null keyspace are
 * processed, so re-running re-counts only still-null rows.
 *
 * Resilient — a single row's storage-read or write failure is logged and the
 * run continues to the next row, so one unreadable masklist cannot abort the
 * whole backfill. The process exits non-zero if any row failed, so a caller
 * (or CI) can tell a clean run from a partial one.
 *
 * Usage:
 *   bun packages/backend/src/scripts/backfill-masklist-keyspace.ts
 */
import { maskLists } from '@hashhive/shared'
import { and, isNotNull, isNull } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { client, db } from '../db/index.js'
import { computeAndPersistMasklistKeyspace } from '../services/resources/masklist-keyspace.js'

async function backfill(): Promise<number> {
  const rows = await db
    .select({ id: maskLists.id, fileRef: maskLists.fileRef })
    .from(maskLists)
    .where(and(isNull(maskLists.keyspace), isNotNull(maskLists.fileRef)))

  logger.info({ count: rows.length }, 'masklist keyspace backfill: candidates found')

  let computed = 0
  let skipped = 0
  let failed = 0
  for (const row of rows) {
    const fileRef = row.fileRef as { bucket?: string; key?: string } | null
    if (!fileRef?.key) {
      skipped++
      continue
    }

    try {
      const keyspace = await computeAndPersistMasklistKeyspace(row.id, {
        key: fileRef.key,
        ...(fileRef.bucket ? { bucket: fileRef.bucket } : {}),
      })
      if (keyspace !== null) computed++
      logger.info({ masklistId: row.id, keyspace }, 'masklist keyspace backfilled')
    } catch (err) {
      // One unreadable masklist must not abort the whole run — log and continue.
      failed++
      logger.error({ masklistId: row.id, err }, 'masklist keyspace backfill: row failed, skipping')
    }
  }

  logger.info(
    {
      total: rows.length,
      computed,
      failed,
      uncomputableOrSkipped: rows.length - computed - failed,
    },
    'masklist keyspace backfill complete'
  )
  if (skipped > 0) {
    logger.warn({ skipped }, 'masklist keyspace backfill: rows skipped (no file reference)')
  }
  return failed
}

backfill()
  .then(async (failed) => {
    await client.end()
    // Non-zero exit when any row failed so partial runs are detectable.
    if (failed > 0) process.exit(1)
  })
  .catch(async (err) => {
    logger.error({ err }, 'masklist keyspace backfill failed')
    await client.end()
    process.exit(1)
  })
