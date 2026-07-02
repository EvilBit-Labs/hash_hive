/**
 * Hash-list / resource archive & restore (ADR-0019, issue #106 U3).
 *
 * Extracted from `services/resources.ts` to keep that file's core
 * CRUD/upload layer from growing past the project's file-size guideline —
 * mirrors the relationship between `services/campaigns.ts` and
 * `services/campaign-dashboard.ts` (draft-only delete + archive/restore
 * live in the sibling file; callers import directly from here rather than
 * through a re-export facade).
 *
 * Both function pairs mirror `campaign-dashboard.ts`'s
 * `archiveCampaigns`/`restoreCampaigns`: bulk fan-out with a per-id
 * pre-check, a guarded UPDATE folding every eligibility condition into its
 * WHERE, and a per-id `catch` so one bad id never fails the whole batch.
 * Archivable = permanent + status='ready' (the archive-consistency check
 * constraint's other half).
 */
import {
  attacks,
  campaigns,
  hashLists,
  type ResourceArchiveResponse,
  type ResourceRestoreResponse,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'
import { entityTypeForTable, type ResourceTable } from './resources.js'

const HASH_LIST_ARCHIVABLE_STATUSES = ['ready'] as const

/**
 * Archive is refused while a non-archived campaign still references the
 * list (R3) — closed atomically via a NOT EXISTS clause folded into the
 * guarded UPDATE, not just the pre-check, so a campaign created between
 * the pre-check and the UPDATE cannot slip an in-use hash list into
 * archived state.
 */
export async function archiveHashLists(
  projectId: number,
  ids: number[],
  actor: AuditActor = { actorType: 'system', actorId: null }
): Promise<ResourceArchiveResponse['results']> {
  return Promise.all(
    ids.map(async (id): Promise<ResourceArchiveResponse['results'][number]> => {
      try {
        const [oldRow] = await db
          .select()
          .from(hashLists)
          .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
          .limit(1)

        if (!oldRow) return { id, outcome: 'not_found' }
        if (oldRow.archivedAt) return { id, outcome: 'already_archived' }
        if (
          !oldRow.isPermanent ||
          !HASH_LIST_ARCHIVABLE_STATUSES.includes(
            oldRow.status as (typeof HASH_LIST_ARCHIVABLE_STATUSES)[number]
          )
        ) {
          return { id, outcome: 'not_archivable' }
        }

        const result = await db.transaction(async (tx) => {
          const archivedAt = new Date()
          const updated = await tx
            .update(hashLists)
            .set({ archivedAt, updatedAt: new Date() })
            .where(
              and(
                eq(hashLists.id, id),
                eq(hashLists.projectId, projectId),
                eq(hashLists.status, 'ready'),
                eq(hashLists.isPermanent, true),
                isNull(hashLists.archivedAt),
                sql`NOT EXISTS (SELECT 1 FROM ${campaigns} WHERE ${and(
                  eq(campaigns.hashListId, hashLists.id),
                  isNull(campaigns.archivedAt)
                )})`
              )
            )
            .returning({ id: hashLists.id })

          if (!updated[0]) {
            // Race: eligibility or in-use state changed between pre-check and UPDATE.
            return null
          }

          await recordAuditEvent(
            {
              actor,
              projectId,
              entityType: 'hash_list',
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
        // exactly four conditions (found + ready + permanent + not archived
        // + no non-archived referencing campaign); whichever is now false
        // determines the outcome.
        const [row] = await db
          .select({
            status: hashLists.status,
            isPermanent: hashLists.isPermanent,
            archivedAt: hashLists.archivedAt,
          })
          .from(hashLists)
          .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
          .limit(1)
        if (!row) return { id, outcome: 'not_found' }
        if (row.archivedAt) return { id, outcome: 'already_archived' }
        if (!row.isPermanent || row.status !== 'ready') return { id, outcome: 'not_archivable' }
        return { id, outcome: 'in_use' }
      } catch (err) {
        logger.error({ err, hashListId: id, projectId }, 'archiveHashLists: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}

export async function restoreHashLists(
  projectId: number,
  ids: number[],
  actor: AuditActor = { actorType: 'system', actorId: null }
): Promise<ResourceRestoreResponse['results']> {
  return Promise.all(
    ids.map(async (id): Promise<ResourceRestoreResponse['results'][number]> => {
      try {
        const [oldRow] = await db
          .select()
          .from(hashLists)
          .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
          .limit(1)

        if (!oldRow) return { id, outcome: 'not_found' }
        if (!oldRow.archivedAt) return { id, outcome: 'not_archived' }

        const result = await db.transaction(async (tx) => {
          const updated = await tx
            .update(hashLists)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(
              and(
                eq(hashLists.id, id),
                eq(hashLists.projectId, projectId),
                isNotNull(hashLists.archivedAt)
              )
            )
            .returning({ id: hashLists.id })

          if (!updated[0]) {
            // Race: archivedAt was cleared between pre-check and UPDATE.
            return null
          }

          await recordAuditEvent(
            {
              actor,
              projectId,
              entityType: 'hash_list',
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
          .select({ id: hashLists.id })
          .from(hashLists)
          .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
          .limit(1)
        return { id, outcome: row ? 'not_archived' : 'not_found' }
      } catch (err) {
        logger.error({ err, hashListId: id, projectId }, 'restoreHashLists: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}

/** The `attacks` FK column that references a given resource table. */
function attackFkColumnForTable(table: ResourceTable) {
  if (table === wordLists) return attacks.wordlistId
  if (table === ruleLists) return attacks.rulelistId
  return attacks.masklistId
}

const RESOURCE_ARCHIVABLE_STATUSES = ['ready'] as const

/**
 * Generic over word/rule/mask lists — same shape as `archiveHashLists`,
 * except the in-use dependent is an `attacks` row instead of a `campaigns`
 * row.
 */
export async function archiveResources(
  table: ResourceTable,
  projectId: number,
  ids: number[],
  actor: AuditActor = { actorType: 'system', actorId: null }
): Promise<ResourceArchiveResponse['results']> {
  const entityType = entityTypeForTable(table)
  const attackFk = attackFkColumnForTable(table)
  return Promise.all(
    ids.map(async (id): Promise<ResourceArchiveResponse['results'][number]> => {
      try {
        const [oldRow] = await db
          .select()
          .from(table)
          .where(and(eq(table.id, id), eq(table.projectId, projectId)))
          .limit(1)

        if (!oldRow) return { id, outcome: 'not_found' }
        if (oldRow.archivedAt) return { id, outcome: 'already_archived' }
        if (
          !oldRow.isPermanent ||
          !RESOURCE_ARCHIVABLE_STATUSES.includes(
            oldRow.status as (typeof RESOURCE_ARCHIVABLE_STATUSES)[number]
          )
        ) {
          return { id, outcome: 'not_archivable' }
        }

        const result = await db.transaction(async (tx) => {
          const archivedAt = new Date()
          const updated = await tx
            .update(table)
            .set({ archivedAt, updatedAt: new Date() })
            .where(
              and(
                eq(table.id, id),
                eq(table.projectId, projectId),
                eq(table.status, 'ready'),
                eq(table.isPermanent, true),
                isNull(table.archivedAt),
                // R3: refuse while a non-archived attack still references this
                // resource — an archived attack no longer counts as "in use"
                // (issue #106 U6 added attacks.archived_at).
                sql`NOT EXISTS (SELECT 1 FROM ${attacks} WHERE ${and(
                  eq(attackFk, table.id),
                  isNull(attacks.archivedAt)
                )})`
              )
            )
            .returning({ id: table.id })

          if (!updated[0]) {
            return null
          }

          await recordAuditEvent(
            {
              actor,
              projectId,
              entityType,
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

        // Re-classify the race-miss (see archiveHashLists for the same shape).
        const [row] = await db
          .select({
            status: table.status,
            isPermanent: table.isPermanent,
            archivedAt: table.archivedAt,
          })
          .from(table)
          .where(and(eq(table.id, id), eq(table.projectId, projectId)))
          .limit(1)
        if (!row) return { id, outcome: 'not_found' }
        if (row.archivedAt) return { id, outcome: 'already_archived' }
        if (!row.isPermanent || row.status !== 'ready') return { id, outcome: 'not_archivable' }
        return { id, outcome: 'in_use' }
      } catch (err) {
        logger.error({ err, resourceId: id, projectId }, 'archiveResources: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}

export async function restoreResources(
  table: ResourceTable,
  projectId: number,
  ids: number[],
  actor: AuditActor = { actorType: 'system', actorId: null }
): Promise<ResourceRestoreResponse['results']> {
  const entityType = entityTypeForTable(table)
  return Promise.all(
    ids.map(async (id): Promise<ResourceRestoreResponse['results'][number]> => {
      try {
        const [oldRow] = await db
          .select()
          .from(table)
          .where(and(eq(table.id, id), eq(table.projectId, projectId)))
          .limit(1)

        if (!oldRow) return { id, outcome: 'not_found' }
        if (!oldRow.archivedAt) return { id, outcome: 'not_archived' }

        const result = await db.transaction(async (tx) => {
          const updated = await tx
            .update(table)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(
              and(eq(table.id, id), eq(table.projectId, projectId), isNotNull(table.archivedAt))
            )
            .returning({ id: table.id })

          if (!updated[0]) {
            return null
          }

          await recordAuditEvent(
            {
              actor,
              projectId,
              entityType,
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
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.id, id), eq(table.projectId, projectId)))
          .limit(1)
        return { id, outcome: row ? 'not_archived' : 'not_found' }
      } catch (err) {
        logger.error({ err, resourceId: id, projectId }, 'restoreResources: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}
