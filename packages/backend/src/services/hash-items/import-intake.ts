/**
 * Shared import intake helper (issue #102, unit U6/U7).
 *
 * `stageAndEnqueueImport` encapsulates the parse → stage → enqueue pipeline
 * that both the dashboard and control import routes share. It returns a
 * discriminated result so each surface can map `reason` to its own exact
 * error shape (dashboardError vs problemResponse) without coupling this
 * module to either surface's error helpers.
 *
 * Cleanup contract:
 *   - `staging_failed`: the staging file was never created; no cleanup needed.
 *   - `queue_unavailable`: the staging file is deleted best-effort before returning.
 *   - Unexpected throw after staging: the file is deleted best-effort and the
 *     error is rethrown so the calling handler's outer catch can return a 500.
 */

import type { ImportFormat } from '@hashhive/shared'

import { randomUUID } from 'node:crypto'

import type { AuditActor } from '../audit-log.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { deleteFile, uploadFile } from '../../config/storage.js'
import { buildHashImportJobId } from '../../queue/workers/hash-import-worker.js'
import { getHashListById, getHashTypeById } from '../resources.js'
import { parseImportContent } from './import-parse.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImportActor = Extract<AuditActor, { actorType: 'user' }>

export type ImportIntakeParams = {
  hashListId: number
  projectId: number
  actor: ImportActor
  content: string
  format: ImportFormat
}

export type ImportIntakeResult =
  | { ok: true; skipped: number }
  | { ok: false; reason: 'not_found' | 'staging_failed' | 'queue_unavailable' }

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Parse, stage, and enqueue a pre-cracked import.
 *
 * @param params.hashListId  Target hash list id.
 * @param params.projectId   Owning project — used for the ownership check (KTD9)
 *                           and the staging key prefix.
 * @param params.actor       Who triggered the import (for audit / job metadata).
 * @param params.content     Raw import file content.
 * @param params.format      Explicit format discriminator ('pairs' | 'hashcat-potfile' |
 *                           'john-potfile').
 * @returns `{ ok: true; skipped }` on success, or `{ ok: false; reason }` for
 *          modelled failures. Throws on unexpected errors (after best-effort
 *          staging cleanup so the calling handler can return a 500 cleanly).
 */
export async function stageAndEnqueueImport(
  params: ImportIntakeParams
): Promise<ImportIntakeResult> {
  const { hashListId, projectId, actor, content, format } = params

  // Ownership check before any parse/stage/enqueue work (KTD9)
  const hl = await getHashListById(hashListId, projectId)
  if (!hl) {
    return { ok: false, reason: 'not_found' }
  }

  // Resolve hashcatMode for potfile parsing (KTD5)
  let hashcatMode: number | null = null
  if (hl.hashTypeId !== null) {
    const ht = await getHashTypeById(hl.hashTypeId)
    hashcatMode = ht?.hashcatMode ?? null
  }

  // Parse import content into normalized pairs (U6)
  const parseResult = parseImportContent(content, format, hashcatMode)

  // Stage parsed pairs to object store — keep cleartext out of Redis (KTD3)
  const stagingKey = `${projectId}/import-staging/${randomUUID()}.json`
  try {
    await uploadFile(stagingKey, Buffer.from(JSON.stringify(parseResult.pairs)), 'application/json')
  } catch (err) {
    logger.error({ err, projectId, hashListId }, 'Failed to stage import pairs')
    return { ok: false, reason: 'staging_failed' }
  }

  // Enqueue U7 propagation job. Wrap in try/catch so an unexpected throw after
  // staging triggers best-effort cleanup before rethrowing — this preserves the
  // dashboard handler's original behaviour of cleaning up orphaned staging files
  // on unhandled errors.
  try {
    // Dynamic import avoids circular dep with queue context.
    const { getQueueManager } = await import('../../queue/context.js')
    const qm = getQueueManager()
    if (!qm) {
      logger.warn({ projectId, hashListId, stagingKey }, 'Queue manager not available')
      deleteFile(stagingKey).catch((cleanupErr) => {
        logger.warn({ err: cleanupErr, stagingKey }, 'Failed to delete orphaned staging file')
      })
      return { ok: false, reason: 'queue_unavailable' }
    }

    const enqueued = await qm.enqueue(
      QUEUE_NAMES.HASH_IMPORT_PROPAGATION,
      {
        stagingKey,
        hashListId,
        projectId,
        actor,
        skippedFromParse: parseResult.skipped,
        // `hashcatMode` (resolved above, for potfile parsing only) is
        // deliberately NOT threaded into the job payload (bug fix, Medium):
        // the worker re-resolves the list's CURRENT mode from its
        // hashTypeId at process time instead of trusting a mode snapshotted
        // here at staging time, which could go stale if `setHashListType`
        // runs before the worker processes this job.
      },
      { jobId: buildHashImportJobId(hashListId, stagingKey) }
    )

    if (!enqueued) {
      logger.warn(
        { projectId, hashListId, stagingKey },
        'import-intake: enqueue returned falsy — deleting orphaned staging file'
      )
      deleteFile(stagingKey).catch((cleanupErr) => {
        logger.warn({ err: cleanupErr, stagingKey }, 'Failed to delete orphaned staging file')
      })
      return { ok: false, reason: 'queue_unavailable' }
    }

    return { ok: true, skipped: parseResult.skipped }
  } catch (err) {
    // Best-effort cleanup before rethrowing — calling handler returns 500.
    deleteFile(stagingKey).catch((cleanupErr) => {
      logger.warn({ err: cleanupErr, stagingKey }, 'Failed to delete staging file after error')
    })
    throw err
  }
}
