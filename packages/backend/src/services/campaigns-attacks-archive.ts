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
import {
  checkSingleHashModePerCampaign,
  findReclaimedResourceRefs,
  isModeConsistencyFkViolation,
} from './campaign-resources.js'

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

        // F2 (issue #106 code review): re-validate the attack's resource
        // refs before clearing archived_at. Without this, a
        // create-attack -> archive-attack -> [blob-reclamation sweep
        // reclaims the referenced wordlist/rulelist/masklist] ->
        // restore-attack sequence would silently resurrect an attack that
        // references a blobless shell — the scheduler would then generate
        // tasks against a missing file (violates R12). Scoped to the
        // reclaimed-shell check only (not the F5 archived-ref check):
        // this mirrors the create/update attack paths' existing
        // pre-check, which is a plain read before the write rather than a
        // guard folded into the UPDATE's WHERE — the same narrow,
        // accepted race window (a reclaim landing between this check and
        // the UPDATE below) already exists on those paths, since blob
        // reclamation only sweeps once daily.
        const { reclaimed } = await findReclaimedResourceRefs(projectId, {
          wordlistId: oldRow.wordlistId,
          rulelistId: oldRow.rulelistId,
          masklistId: oldRow.masklistId,
        })
        if (reclaimed.length > 0) {
          return { id, outcome: 'resource_reclaimed' }
        }

        // Single-hash-mode-per-campaign guard (issue #100 R15 / AS1 code
        // review fix): restoring un-archives the attack, making it a
        // sibling again for the mode-consistency invariant the campaign
        // ETA rollup depends on. Without this check, archive -> create a
        // different-mode attack -> restore would silently re-introduce a
        // mixed-mode campaign. Checked per-id (mirrors the reclaimed-shell
        // check above); a batch restoring two different-mode archived
        // attacks together, with no other non-archived sibling, can still
        // slip through both checks since neither observes the other's
        // not-yet-committed row — an accepted, narrow race the same as
        // every other pre-check-then-write guard on this path.
        const modeCheck = await checkSingleHashModePerCampaign(oldRow.campaignId, oldRow.mode, id)
        if (!modeCheck.valid) {
          return { id, outcome: 'mode_conflict' }
        }

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
        // Single-hash-mode-per-campaign DB backstop (issue #100): restoring
        // never touches `campaignId`/`mode` (only `archivedAt`), so Postgres
        // has no reason to re-check the composite FK here — the pre-check
        // above is expected to be the only gate that fires in practice.
        // This mapping is a defensive backstop in case that invariant ever
        // breaks, so a race still surfaces as the typed `mode_conflict`
        // outcome rather than a generic per-id `error`.
        if (isModeConsistencyFkViolation(err)) {
          return { id, outcome: 'mode_conflict' }
        }
        logger.error({ err, attackId: id, projectId }, 'restoreAttacks: per-id failure')
        return { id, outcome: 'error' }
      }
    })
  )
}
