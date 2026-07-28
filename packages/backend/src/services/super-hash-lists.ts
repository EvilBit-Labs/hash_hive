/**
 * SuperHashlist lifecycle + membership services (issue #101 — U7).
 *
 * A SuperHashlist (KTD5) is a named, read-time union over several member hash
 * lists. It owns no hash items (R10); membership lives in the
 * `super_hash_list_members` join table. This module is the service layer the
 * dashboard (U8) and control (U9) routes call to create, rename, archive, and
 * manage the membership of a super.
 *
 * Invariants enforced here as DEFENSE-IN-DEPTH atop the database guards, so
 * callers get a clean domain error instead of a raw Postgres constraint
 * violation bubbling out as a 500:
 *   - R5: every member must live in the super's project. The DB backstop is
 *     the `super_member_project_check` trigger (migration 0042); we pre-check
 *     and also map its `check_violation` (SQLSTATE 23514) to a domain error.
 *   - R3: a hash list belongs to at most one super. The DB backstop is
 *     `UNIQUE(member_hash_list_id)`; we pre-check and also map its
 *     `unique_violation` (SQLSTATE 23505) to a domain error.
 *
 * The U12 add-member reconciliation hook and the U13 remove-member
 * drain→harvest→detach implementation land in THEIR units. Here `addMember`
 * is a plain insert and `removeMember` is a plain membership-row delete
 * (see the TODO(U13) note). Members remain independently targetable by their
 * own campaigns (R3) — nothing here touches a member's own campaign paths.
 *
 * Patterns mirrored from `services/resources.ts` (`getHashListById`,
 * `listHashListsPaginated`, `isForeignKeyViolation`) and
 * `services/resources-archive.ts` (archive as an `archivedAt` stamp).
 */

import { hashItems, hashLists, superHashListMembers, superHashLists } from '@hashhive/shared'
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { backfillCrackedSetFromMember } from './hash-items/cracked-set.js'
import { resolveNodeToLeaves } from './hash-items/node-resolution/index.js'

// ─── Types ──────────────────────────────────────────────────────────

/** A `super_hash_lists` row as stored/returned. */
export type SuperHashListRow = typeof superHashLists.$inferSelect

/** A super plus its member hash-list ids (the union's membership). */
export type SuperHashListWithMembers = SuperHashListRow & { memberIds: number[] }

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbRunner = DbTx | typeof db

// ─── Domain errors ──────────────────────────────────────────────────
//
// Thrown (not returned) so the route layer can translate each to the right
// 4xx envelope on its surface (dashboard `{ error }` / control problem+json)
// rather than letting a raw pg constraint violation fall through to a 500.

/**
 * R5: one or more proposed member hash lists do not belong to the super's
 * project (or do not exist). Also the mapped form of the tenant trigger's
 * `check_violation` and a member-FK violation.
 */
export class SuperMemberProjectMismatchError extends Error {
  readonly memberIds: number[]
  constructor(memberIds: number[]) {
    super(`hash list(s) ${memberIds.join(', ')} do not belong to this project or do not exist`)
    this.name = 'SuperMemberProjectMismatchError'
    this.memberIds = memberIds
  }
}

/**
 * R3: one or more proposed member hash lists are already a member of some
 * super (a hash list belongs to at most one super). Also the mapped form of
 * the `UNIQUE(member_hash_list_id)` violation, including a duplicate add of
 * the same member.
 */
export class SuperMemberAlreadyInSuperError extends Error {
  readonly memberIds: number[]
  constructor(memberIds: number[]) {
    super(`hash list(s) ${memberIds.join(', ')} already belong to a super hash list`)
    this.name = 'SuperMemberAlreadyInSuperError'
    this.memberIds = memberIds
  }
}

// ─── Postgres error-code helpers ────────────────────────────────────

function pgErrorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    return (err as { code?: string }).code
  }
  return undefined
}

/** SQLSTATE 23505 unique_violation — the `UNIQUE(member_hash_list_id)` guard (R3). */
function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505'
}

/**
 * SQLSTATE 23514 check_violation — raised by the `super_member_project_check`
 * trigger for a cross-project member (R5). SQLSTATE 23503 foreign_key_violation
 * — a member/super id that does not exist.
 */
function isCheckOrFkViolation(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === '23514' || code === '23503'
}

// ─── Membership helpers ─────────────────────────────────────────────

/** Distinct, order-preserving copy of `ids`. */
function dedupe(ids: number[]): number[] {
  return [...new Set(ids)]
}

async function fetchMemberIds(runner: DbRunner, superId: number): Promise<number[]> {
  const rows = await runner
    .select({ memberHashListId: superHashListMembers.memberHashListId })
    .from(superHashListMembers)
    .where(eq(superHashListMembers.superHashListId, superId))
    .orderBy(superHashListMembers.memberHashListId)
  return rows.map((r) => r.memberHashListId)
}

/**
 * Validate that every id in `memberIds` (a) belongs to `projectId` (R5) and
 * (b) is not already a member of any super (R3). Throws the matching domain
 * error otherwise. A no-op for an empty list.
 */
async function assertMembersEligible(
  runner: DbRunner,
  projectId: number,
  memberIds: number[]
): Promise<void> {
  if (memberIds.length === 0) return

  // R5: each member must be a hash list in this project.
  const belonging = await runner
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(and(eq(hashLists.projectId, projectId), inArray(hashLists.id, memberIds)))
  const belongingIds = new Set(belonging.map((r) => r.id))
  const foreign = memberIds.filter((id) => !belongingIds.has(id))
  if (foreign.length > 0) {
    throw new SuperMemberProjectMismatchError(foreign)
  }

  // R3: none may already be a member of any super.
  const existing = await runner
    .select({ memberHashListId: superHashListMembers.memberHashListId })
    .from(superHashListMembers)
    .where(inArray(superHashListMembers.memberHashListId, memberIds))
  if (existing.length > 0) {
    throw new SuperMemberAlreadyInSuperError(existing.map((r) => r.memberHashListId))
  }
}

/**
 * Map a Postgres constraint violation raised by a membership write to the
 * matching clean domain error (defense-in-depth against a race between the
 * app-level pre-check and the write). Re-throws anything else unchanged.
 */
function rethrowMembershipViolation(err: unknown, memberIds: number[]): never {
  if (isUniqueViolation(err)) {
    throw new SuperMemberAlreadyInSuperError(memberIds)
  }
  if (isCheckOrFkViolation(err)) {
    throw new SuperMemberProjectMismatchError(memberIds)
  }
  throw err
}

// ─── Reads (project-scoped) ─────────────────────────────────────────

/**
 * Project-scoped super lookup with membership. Returns `null` on a miss so a
 * wrong-project id cannot disclose existence (mirrors `getHashListById`).
 */
export async function getSuperById(
  id: number,
  projectId: number
): Promise<SuperHashListWithMembers | null> {
  const [row] = await db
    .select()
    .from(superHashLists)
    .where(and(eq(superHashLists.id, id), eq(superHashLists.projectId, projectId)))
    .limit(1)
  if (!row) return null
  const memberIds = await fetchMemberIds(db, id)
  return { ...row, memberIds }
}

/**
 * List a project's supers. Archived supers are excluded by default
 * (`showArchived` to include them). `limit`/`offset` are optional so the
 * dashboard can list all while the control surface pages; `total` is the full
 * matching count regardless of the page window (mirrors
 * `listHashListsPaginated`).
 */
export async function listSupers(
  projectId: number,
  opts: {
    limit?: number | undefined
    offset?: number | undefined
    showArchived?: boolean | undefined
  } = {}
): Promise<{ items: SuperHashListRow[]; total: number }> {
  const conditions = [eq(superHashLists.projectId, projectId)]
  if (!opts.showArchived) {
    conditions.push(isNull(superHashLists.archivedAt))
  }
  const whereClause = and(...conditions)

  const baseQuery = db
    .select()
    .from(superHashLists)
    .where(whereClause)
    .orderBy(desc(superHashLists.createdAt), desc(superHashLists.id))
  const pagedQuery =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery

  const [items, countResult] = await Promise.all([
    pagedQuery,
    db.select({ value: count() }).from(superHashLists).where(whereClause),
  ])
  return { items, total: Number(countResult[0]?.value ?? 0) }
}

// ─── Lifecycle ──────────────────────────────────────────────────────

/**
 * Create a super with an optional initial member set.
 *
 * MINIMUM MEMBER COUNT (plan Open Question — "Minimum member count
 * enforcement point"): this unit deliberately allows 0 or 1 member at create
 * time so a super can be built up incrementally in the UI. The ≥2-members
 * invariant (R2) is enforced only at campaign-target time (U10), NOT here. Do
 * not hard-fail create on <2 members.
 *
 * Validates each member against R5 (belongs to the project) and R3 (not
 * already in another super) as defense-in-depth atop the DB trigger + unique
 * index, surfacing a clean domain error rather than a raw constraint
 * violation.
 */
export async function createSuper(input: {
  projectId: number
  name: string
  memberIds?: number[] | undefined
}): Promise<SuperHashListWithMembers> {
  const memberIds = dedupe(input.memberIds ?? [])

  try {
    return await db.transaction(async (tx) => {
      // Pre-check inside the txn so the eligibility read and the writes share
      // one snapshot; the DB guards below still catch a concurrent race.
      await assertMembersEligible(tx, input.projectId, memberIds)

      const [superRow] = await tx
        .insert(superHashLists)
        .values({ projectId: input.projectId, name: input.name })
        .returning()
      if (!superRow) {
        throw new Error('createSuper: insert returned no row')
      }

      if (memberIds.length > 0) {
        await tx.insert(superHashListMembers).values(
          memberIds.map((memberHashListId) => ({
            superHashListId: superRow.id,
            memberHashListId,
          }))
        )
      }

      return { ...superRow, memberIds }
    })
  } catch (err) {
    if (
      err instanceof SuperMemberProjectMismatchError ||
      err instanceof SuperMemberAlreadyInSuperError
    ) {
      throw err
    }
    rethrowMembershipViolation(err, memberIds)
  }
}

/**
 * Rename a super (project-scoped). Returns the updated row, or `null` if no
 * super with `(id, projectId)` exists.
 */
export async function renameSuper(
  id: number,
  projectId: number,
  name: string
): Promise<SuperHashListRow | null> {
  const [updated] = await db
    .update(superHashLists)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(superHashLists.id, id), eq(superHashLists.projectId, projectId)))
    .returning()
  return updated ?? null
}

/**
 * Archive a super by stamping `archivedAt` (project-scoped, lifecycle parity
 * with hash lists — ADR-0019). Idempotent: an already-archived super is
 * returned unchanged without moving its timestamp. Returns `null` on a
 * wrong-project / missing id.
 *
 * The guard that rejects an archived super for campaign targeting lives in
 * U10; this unit only sets `archivedAt`.
 */
export async function archiveSuper(
  id: number,
  projectId: number
): Promise<SuperHashListRow | null> {
  const [existing] = await db
    .select()
    .from(superHashLists)
    .where(and(eq(superHashLists.id, id), eq(superHashLists.projectId, projectId)))
    .limit(1)
  if (!existing) return null
  if (existing.archivedAt) return existing

  const [updated] = await db
    .update(superHashLists)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(superHashLists.id, id),
        eq(superHashLists.projectId, projectId),
        isNull(superHashLists.archivedAt)
      )
    )
    .returning()
  return updated ?? existing
}

// ─── Membership mutation ────────────────────────────────────────────

/**
 * Add a hash list to a super's membership. Project-scoped: returns `null` if
 * the super does not exist in `projectId`. Throws `SuperMemberProjectMismatchError`
 * (R5, member not in project) or `SuperMemberAlreadyInSuperError` (R3, member
 * already in a super — including a duplicate add of the same member) rather
 * than surfacing a raw constraint violation.
 *
 * The U12 add-member retroactive reconciliation (backfilling already-cracked
 * `(mode, value)` rows into the project cracked-set) is layered on in U12;
 * here this is a plain membership insert.
 */
export async function addMember(
  superId: number,
  hashListId: number,
  projectId: number
): Promise<SuperHashListWithMembers | null> {
  const [superRow] = await db
    .select({ id: superHashLists.id })
    .from(superHashLists)
    .where(and(eq(superHashLists.id, superId), eq(superHashLists.projectId, projectId)))
    .limit(1)
  if (!superRow) return null

  try {
    // Membership insert + retroactive cracked-set backfill (U12/R9) are one
    // transaction: a new member's already-cracked hashes are reconciled into
    // the project cracked-set atomically with the join, so a sibling member's
    // uncracked duplicate resolves cracked (U4) the instant the add commits —
    // never a window where the row is a member but its cracks are not yet
    // dedup-visible.
    await db.transaction(async (tx) => {
      await assertMembersEligible(tx, projectId, [hashListId])
      await tx
        .insert(superHashListMembers)
        .values({ superHashListId: superId, memberHashListId: hashListId })
      await backfillCrackedSetFromMember(tx, projectId, hashListId)
    })
  } catch (err) {
    if (
      err instanceof SuperMemberProjectMismatchError ||
      err instanceof SuperMemberAlreadyInSuperError
    ) {
      throw err
    }
    rethrowMembershipViolation(err, [hashListId])
  }

  return getSuperById(superId, projectId)
}

/**
 * Resolve a single super member to its physical typed-leaf hash-list ids
 * (U13 harvest). Mirrors the super resolver's per-member expansion: a member
 * that is a #202 split PARENT contributes its physical children; a homogeneous
 * member IS its own leaf. Project-scoped (IDOR guard).
 */
async function resolveMemberLeaves(
  runner: DbRunner,
  memberHashListId: number,
  projectId: number
): Promise<number[]> {
  const children = await runner
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(
      and(eq(hashLists.parentHashListId, memberHashListId), eq(hashLists.projectId, projectId))
    )
  return children.length > 0 ? children.map((c) => c.id) : [memberHashListId]
}

/**
 * Remove a hash list from a super's membership (U13, R14/R17).
 *
 * Project-scoped: returns `null` if the super does not exist in `projectId`.
 *
 * Ordering (KTD9 / adversarial F4) — correctness rests on the project-wide
 * cracked-set, NOT on any drain:
 *
 *   0. Dispatch-stop (deliberately deferred). A poll-based agent model cannot
 *      recall an already-dispatched chunk, and it does not need to: every crack
 *      an in-flight chunk submits is written to the project cracked-set (U2)
 *      regardless of membership and is never pruned on removal, so a remaining
 *      member still resolves the `(mode, value)` cracked via the U4 read-time
 *      resolver whether or not a harvest ran. Actively pausing the super's
 *      sub-campaign dispatch for the leaving leaf is a best-effort optimization
 *      that would touch campaign lifecycle (and risk R3 — the list stays
 *      independently targetable); it is intentionally NOT done here.
 *   1. Harvest (the sole write-back). Under a `FOR UPDATE` lock covering the
 *      SOURCE snapshot rows — the removed member's cracked `hash_items`, not
 *      just the destinations — so a concurrent re-crack cannot make the harvest
 *      persist a stale plaintext. A single atomic `UPDATE … FROM` copies each
 *      cracked `(mode, value)` plaintext onto the remaining members' UNCRACKED
 *      rows sharing that value. This exists only for surfaces still reading
 *      `hash_items` directly per the R15 inventory (U4); its scope shrinks as
 *      that inventory is completed. The match reference (R17) is the cracked-set
 *      row's own `sourceHashListId` — the harvest writes only plaintext +
 *      crackedAt to the destination, never the removed member's identity.
 *   2. Detach the membership row.
 *
 * If the removed member was the last making a `(mode, value)` present, its
 * cracked-set entry remains — project-wide crack-once is not undone by removal.
 */
export async function removeMember(
  superId: number,
  hashListId: number,
  projectId: number
): Promise<SuperHashListWithMembers | null> {
  const [superRow] = await db
    .select({ id: superHashLists.id })
    .from(superHashLists)
    .where(and(eq(superHashLists.id, superId), eq(superHashLists.projectId, projectId)))
    .limit(1)
  if (!superRow) return null

  // Resolve the leaves BEFORE detaching (the super resolver still counts the
  // leaving member): source = the removed member's leaves; destination = every
  // OTHER current member's leaves.
  const [allLeaves, sourceLeaves] = await Promise.all([
    resolveNodeToLeaves({ kind: 'super', superHashListId: superId, projectId }),
    resolveMemberLeaves(db, hashListId, projectId),
  ])
  const sourceSet = new Set(sourceLeaves)
  const destLeaves = allLeaves.filter((id) => !sourceSet.has(id))

  await db.transaction(async (tx) => {
    // (1) Harvest — skipped only when there is genuinely nothing to move
    // (no source leaves, or no remaining members to harvest into).
    if (sourceLeaves.length > 0 && destLeaves.length > 0) {
      // Lock the SOURCE snapshot rows (the removed member's cracked items) so a
      // concurrent re-crack cannot change their plaintext mid-harvest (security).
      await tx
        .select({ id: hashItems.id })
        .from(hashItems)
        .where(
          and(
            inArray(hashItems.hashListId, sourceLeaves),
            isNotNull(hashItems.crackedAt),
            isNotNull(hashItems.detectedHashcatMode)
          )
        )
        .for('update')

      // Postgres array literals for the leaf-id lists. These are integer PKs
      // read from our own DB (never user text), and `Number()`-coerced, so
      // inlining them is injection-safe — and it sidesteps postgres-js failing
      // to type an array parameter passed to `ANY(...)` in a raw statement.
      const srcLeafArray = sql.raw(`ARRAY[${sourceLeaves.map(Number).join(',')}]::int[]`)
      const destLeafArray = sql.raw(`ARRAY[${destLeaves.map(Number).join(',')}]::int[]`)

      // Single-statement atomic write-back: each source-cracked (mode, value)
      // fills the remaining members' UNCRACKED matching rows. DISTINCT ON keeps
      // one source row per (mode, value) — its earliest crack — so a value
      // present twice in the source cannot make the join ambiguous.
      await tx.execute(sql`
        UPDATE ${hashItems} AS dest
        SET plaintext = src.plaintext, cracked_at = src.cracked_at
        FROM (
          SELECT DISTINCT ON (${hashItems.detectedHashcatMode}, ${hashItems.hashValue})
            ${hashItems.detectedHashcatMode} AS detected_hashcat_mode,
            ${hashItems.hashValue} AS hash_value,
            ${hashItems.plaintext} AS plaintext,
            ${hashItems.crackedAt} AS cracked_at
          FROM ${hashItems}
          WHERE ${hashItems.hashListId} = ANY(${srcLeafArray})
            AND ${hashItems.crackedAt} IS NOT NULL
            AND ${hashItems.detectedHashcatMode} IS NOT NULL
            AND ${hashItems.plaintext} IS NOT NULL
          ORDER BY ${hashItems.detectedHashcatMode}, ${hashItems.hashValue}, ${hashItems.crackedAt} ASC
        ) AS src
        WHERE dest.hash_list_id = ANY(${destLeafArray})
          AND dest.cracked_at IS NULL
          AND dest.detected_hashcat_mode = src.detected_hashcat_mode
          AND dest.hash_value = src.hash_value
      `)
    }

    // (2) Detach the membership row.
    await tx
      .delete(superHashListMembers)
      .where(
        and(
          eq(superHashListMembers.superHashListId, superId),
          eq(superHashListMembers.memberHashListId, hashListId)
        )
      )
  })

  return getSuperById(superId, projectId)
}
