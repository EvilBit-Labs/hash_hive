/**
 * Attack archive & restore (ADR-0019, issue #106 U6).
 *
 * Extracted from `services/campaigns.ts` to keep that module's core
 * CRUD/lifecycle layer under the project's file-size guideline — mirrors
 * the relationship between `services/resources.ts` and
 * `services/resources-archive.ts`. Re-exported through the
 * `services/campaigns` facade so callers don't need a second import path.
 *
 * Mirrors `archiveResources`/`restoreResources`'s shape (bulk fan-out
 * with a per-id pre-check, a guarded UPDATE folding every eligibility
 * condition into its WHERE, and a per-id `catch` so one bad id never
 * fails the whole batch) with two differences that follow from attacks
 * carrying no persisted `status` column (issue #99) and nothing
 * referencing an attack the way campaigns reference hash lists:
 *   - Archivable = permanent only (no `status IN (...)` clause).
 *   - No `in_use` outcome / dependent guard.
 */
import { attacks, type AttackArchiveResponse, type AttackRestoreResponse } from '@hashhive/shared'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'

/**
 * Archive is refused for a task-less (never-latched) attack — see
 * `attacks_archive_consistency_chk` (`archived_at IS NULL OR is_permanent
 * = true`). Unlike campaigns/resources, no status clause and no
 * referenced-by guard: an attack can be archived in any derived status
 * (R6 — archiving a running attack is how an operator stops it from
 * receiving new scheduling).
 */
export async function archiveAttacks(
  projectId: number,
  ids: number[],
  actor: AuditActor = { actorType: 'system', actorId: null }
): Promise<AttackArchiveResponse['results']> {
  return Promise.all(
    ids.map(async (id): Promise<AttackArchiveResponse['results'][number]> => {
      try {
        const [oldRow] = await db
          .select()
          .from(attacks)
          .where(and(eq(attacks.id, id), eq(attacks.projectId, projectId)))
          .limit(1)

        if (!oldRow) return { id, outcome: 'not_found' }
        if (oldRow.archivedAt) return { id, outcome: 'already_archived' }
        if (!oldRow.isPermanent) return { id, outcome: 'not_archivable' }

        const result = await db.transaction(async (tx) => {
          const archivedAt = new Date()
          const updated = await tx
            .update(attacks)
            .set({ archivedAt, updatedAt: new Date() })
            .where(
              and(
                eq(attacks.id, id),
                eq(attacks.projectId, projectId),
                eq(attacks.isPermanent, true),
                isNull(attacks.archivedAt)
              )
            )
            .returning({ id: attacks.id })

          if (!updated[0]) {
            // Race: eligibility or archive state changed between pre-check
            // and UPDATE.
            return null
          }

          await recordAuditEvent(
            {
              actor,
              projectId,
              entityType: 'attack',
              entityId: id,
              action: 'archived',
              oldRow: oldRow as Record<string, unknown>,
              newRow: { ...oldRow, archivedAt } as Record<string, unknown>,
            },
            tx
          )

          return updated[0]
        })

        if (result) return { id, outcome: 'archived' }

        // Re-classify the race-miss. The guarded UPDATE's WHERE covers
        // exactly three conditions (found + permanent + not already
        // archived); whichever is now false determines the outcome.
        const [row] = await db
          .select({ isPermanent: attacks.isPermanent, archivedAt: attacks.archivedAt })
          .from(attacks)
          .where(and(eq(attacks.id, id), eq(attacks.projectId, projectId)))
          .limit(1)
        if (!row) return { id, outcome: 'not_found' }
        if (row.archivedAt) return { id, outcome: 'already_archived' }
        return { id, outcome: 'not_archivable' }
      } catch (err) {
        logger.error({ err, attackId: id, projectId }, 'archiveAttacks: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}

export async function restoreAttacks(
  projectId: number,
  ids: number[],
  actor: AuditActor = { actorType: 'system', actorId: null }
): Promise<AttackRestoreResponse['results']> {
  return Promise.all(
    ids.map(async (id): Promise<AttackRestoreResponse['results'][number]> => {
      try {
        const [oldRow] = await db
          .select()
          .from(attacks)
          .where(and(eq(attacks.id, id), eq(attacks.projectId, projectId)))
          .limit(1)

        if (!oldRow) return { id, outcome: 'not_found' }
        if (!oldRow.archivedAt) return { id, outcome: 'not_archived' }

        const result = await db.transaction(async (tx) => {
          const updated = await tx
            .update(attacks)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(
              and(
                eq(attacks.id, id),
                eq(attacks.projectId, projectId),
                isNotNull(attacks.archivedAt)
              )
            )
            .returning({ id: attacks.id })

          if (!updated[0]) {
            // Race: archivedAt was cleared between pre-check and UPDATE.
            return null
          }

          await recordAuditEvent(
            {
              actor,
              projectId,
              entityType: 'attack',
              entityId: id,
              action: 'restored',
              oldRow: oldRow as Record<string, unknown>,
              newRow: { ...oldRow, archivedAt: null } as Record<string, unknown>,
            },
            tx
          )

          return updated[0]
        })

        if (result) return { id, outcome: 'restored' }

        const [row] = await db
          .select({ id: attacks.id })
          .from(attacks)
          .where(and(eq(attacks.id, id), eq(attacks.projectId, projectId)))
          .limit(1)
        return { id, outcome: row ? 'not_archived' : 'not_found' }
      } catch (err) {
        logger.error({ err, attackId: id, projectId }, 'restoreAttacks: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}
