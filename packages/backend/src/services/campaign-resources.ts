/**
 * Cross-project resource validator for campaigns and attacks.
 *
 * Extracted from `services/campaigns.ts` to keep that module under the
 * project's 800-line file-size guideline. Callers (transitionCampaign,
 * createCampaignWithAttacks, the standalone attack-write routes) keep
 * importing through the `services/campaigns.ts` facade.
 */
import { attacks, hashLists, hashTypes, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'

import { db } from '../db/index.js'
import { deriveAttackRuntimes, isNonTerminalAttackStatus } from './attacks/runtime.js'

// ─── Global (non-archivable) lookups ─────────────────────────────────
//
// `hashTypes` is the only referenced resource with neither `archivedAt`
// nor `blobReclaimedAt` — it's a global, seed-managed catalogue, never
// archived or reclaimed. Existence-only.

async function lookupExistingHashTypeIds(wanted: readonly number[]): Promise<Set<number>> {
  if (wanted.length === 0) return new Set()
  const rows = await db
    .select({ id: hashTypes.id })
    .from(hashTypes)
    .where(inArray(hashTypes.id, [...wanted]))
  return new Set(rows.map((r) => r.id))
}

// ─── Archivable / reclaimable lookups (ADR-0019, issue #106 U11/U12, F5) ──
//
// Every project-scoped resource a campaign or attack can reference —
// hash lists plus word/rule/mask lists — carries `archived_at`; only
// word/rule/mask lists additionally carry `blob_reclaimed_at` (hash
// lists are excluded from blob reclamation — their forensic value is
// the in-DB `hash_items`, not a retained source file). A dedicated,
// concretely-typed map (rather than a wider table union that doesn't
// statically carry these columns) avoids an unsafe cast.

type ArchivableKey = 'hashListId' | 'wordlistId' | 'rulelistId' | 'masklistId'

const ARCHIVABLE_LOOKUPS: Record<
  ArchivableKey,
  {
    table: typeof hashLists | typeof wordLists | typeof ruleLists | typeof maskLists
    idColumn: typeof hashLists.id | typeof wordLists.id | typeof ruleLists.id | typeof maskLists.id
    projectIdColumn:
      | typeof hashLists.projectId
      | typeof wordLists.projectId
      | typeof ruleLists.projectId
      | typeof maskLists.projectId
    archivedAtColumn:
      | typeof hashLists.archivedAt
      | typeof wordLists.archivedAt
      | typeof ruleLists.archivedAt
      | typeof maskLists.archivedAt
    // null for hashLists — hash lists have no blob-reclamation lifecycle.
    blobReclaimedAtColumn:
      | typeof wordLists.blobReclaimedAt
      | typeof ruleLists.blobReclaimedAt
      | typeof maskLists.blobReclaimedAt
      | null
    label: string
  }
> = {
  hashListId: {
    table: hashLists,
    idColumn: hashLists.id,
    projectIdColumn: hashLists.projectId,
    archivedAtColumn: hashLists.archivedAt,
    blobReclaimedAtColumn: null,
    label: 'hashList',
  },
  wordlistId: {
    table: wordLists,
    idColumn: wordLists.id,
    projectIdColumn: wordLists.projectId,
    archivedAtColumn: wordLists.archivedAt,
    blobReclaimedAtColumn: wordLists.blobReclaimedAt,
    label: 'wordlist',
  },
  rulelistId: {
    table: ruleLists,
    idColumn: ruleLists.id,
    projectIdColumn: ruleLists.projectId,
    archivedAtColumn: ruleLists.archivedAt,
    blobReclaimedAtColumn: ruleLists.blobReclaimedAt,
    label: 'rulelist',
  },
  masklistId: {
    table: maskLists,
    idColumn: maskLists.id,
    projectIdColumn: maskLists.projectId,
    archivedAtColumn: maskLists.archivedAt,
    blobReclaimedAtColumn: maskLists.blobReclaimedAt,
    label: 'masklist',
  },
}

/**
 * Existence + archived + reclaimed-shell status in ONE query per table
 * (issue #106 U12, F5): selects `{id, archivedAt, blobReclaimedAt?}`
 * instead of firing a separate SELECT per check. Folding every check into
 * a single read is both cheaper and more correct than multiple reads (one
 * snapshot, no window for the checks to observe different states of the
 * same row).
 *
 * F5 (issue #106 code review): archived-but-not-reclaimed resources were
 * previously invisible to this validator — only `blob_reclaimed_at` was
 * checked, so a newly created/updated attack or campaign could silently
 * reference an archived (hidden-from-listing) hash list / word/rule/mask
 * list, making a hidden resource power live work and permanently blocking
 * its eventual blob reclamation (an active, non-archived attack reference
 * is exactly what the reclamation sweep's NOT EXISTS guard checks for).
 */
async function lookupExistingArchivedReclaimed(
  key: ArchivableKey,
  wanted: readonly number[],
  projectId: number
): Promise<{ foundIds: Set<number>; archivedIds: number[]; reclaimedIds: number[] }> {
  if (wanted.length === 0) return { foundIds: new Set(), archivedIds: [], reclaimedIds: [] }
  const spec = ARCHIVABLE_LOOKUPS[key]
  const whereClause = and(inArray(spec.idColumn, [...wanted]), eq(spec.projectIdColumn, projectId))

  if (spec.blobReclaimedAtColumn) {
    const rows = await db
      .select({
        id: spec.idColumn,
        archivedAt: spec.archivedAtColumn,
        blobReclaimedAt: spec.blobReclaimedAtColumn,
      })
      .from(spec.table)
      .where(whereClause)
    return {
      foundIds: new Set(rows.map((r) => r.id)),
      archivedIds: rows.filter((r) => r.archivedAt != null).map((r) => r.id),
      reclaimedIds: rows.filter((r) => r.blobReclaimedAt != null).map((r) => r.id),
    }
  }

  // hashLists: no blobReclaimedAt column to select.
  const rows = await db
    .select({ id: spec.idColumn, archivedAt: spec.archivedAtColumn })
    .from(spec.table)
    .where(whereClause)
  return {
    foundIds: new Set(rows.map((r) => r.id)),
    archivedIds: rows.filter((r) => r.archivedAt != null).map((r) => r.id),
    reclaimedIds: [],
  }
}

/**
 * Verify every resource referenced by the campaign and its attacks
 * actually exists, and (for project-scoped resources) belongs to the
 * campaign's project. Also flags:
 *   - any word/rule/mask list reference that is a reclaimed shell (issue
 *     #106 U12 / R12) — present, but unusable until re-uploaded and
 *     checksum-verified.
 *   - any hash list / word/rule/mask list reference that is archived
 *     (issue #106 F5 code review) — present, but hidden from listings and
 *     must not be allowed to silently power new/updated live work.
 *
 * Returns the missing/reclaimed/archived resource identifiers grouped by
 * table so the route layer can surface a single combined error.
 *
 * Runs one SELECT per referenced table; all resource id lookups are
 * indexed by primary key.
 *
 * Project scoping:
 *   - `hashLists`, `wordLists`, `ruleLists`, `maskLists` have
 *     `project_id` and are scoped to the campaign's project.
 *   - `hashTypes` is global (no project_id) so it's looked up by id only,
 *     and has no archived/reclaimed lifecycle to check.
 *
 * Null `campaign.hashListId` is a legitimate caller signal: standalone
 * attack-write callers (POST /:id/attacks, PATCH /:id/attacks/:attackId)
 * pass `null` to mean "no hash-list dimension to validate here — the
 * parent campaign's hashList was already validated when the campaign
 * itself was created." Since issue #101 U6, `campaigns.hashListId` is
 * nullable at the DB layer (a super PARENT campaign carries
 * `superHashListId` instead, `num_nonnulls(hashListId, superHashListId)=1`),
 * so a null id is now a real persisted state, not only a caller sentinel —
 * this path already handles it correctly.
 */
export async function validateCampaignResources(
  campaign: { projectId: number; hashListId: number | null },
  campaignAttacks: ReadonlyArray<{
    hashTypeId?: number | null | undefined
    wordlistId?: number | null | undefined
    rulelistId?: number | null | undefined
    masklistId?: number | null | undefined
  }>
): Promise<
  { valid: true } | { valid: false; missing: string[]; reclaimed: string[]; archived: string[] }
> {
  // Collect dedup'd id lists per resource type. Null campaign.hashListId
  // is the documented "skip" signal — keep the wanted list empty so the
  // helper produces no lookup for that dimension.
  const wantedHashType = dedupIds(campaignAttacks, 'hashTypeId')
  const wantedArchivable: Record<ArchivableKey, number[]> = {
    hashListId: campaign.hashListId != null ? [campaign.hashListId] : [],
    wordlistId: dedupIds(campaignAttacks, 'wordlistId'),
    rulelistId: dedupIds(campaignAttacks, 'rulelistId'),
    masklistId: dedupIds(campaignAttacks, 'masklistId'),
  }
  const archivableKeys = (Object.keys(wantedArchivable) as ArchivableKey[]).filter(
    (k) => wantedArchivable[k].length > 0
  )

  if (wantedHashType.length === 0 && archivableKeys.length === 0) {
    return { valid: true }
  }

  // Run every table's lookup in parallel — one indexed SELECT per
  // referenced table.
  const [hashTypeFoundIds, archivableResults] = await Promise.all([
    lookupExistingHashTypeIds(wantedHashType),
    Promise.all(
      archivableKeys.map(async (key) => ({
        key,
        ...(await lookupExistingArchivedReclaimed(key, wantedArchivable[key], campaign.projectId)),
      }))
    ),
  ])

  const missing: string[] = []
  const reclaimed: string[] = []
  const archived: string[] = []

  for (const id of wantedHashType) {
    if (!hashTypeFoundIds.has(id)) missing.push(`hashType(${id})`)
  }

  for (const { key, foundIds, archivedIds, reclaimedIds } of archivableResults) {
    const label = ARCHIVABLE_LOOKUPS[key].label
    for (const id of wantedArchivable[key]) {
      if (!foundIds.has(id)) {
        missing.push(`${label}(${id})`)
      }
    }
    for (const id of archivedIds) {
      archived.push(`${label}(${id})`)
    }
    for (const id of reclaimedIds) {
      reclaimed.push(`${label}(${id})`)
    }
  }

  return missing.length === 0 && reclaimed.length === 0 && archived.length === 0
    ? { valid: true }
    : { valid: false, missing, reclaimed, archived }
}

/**
 * Standalone reclaimed-shell / archived check for callers that don't go
 * through `validateCampaignResources` (issue #106 U12 / R12, F5) —
 * currently the Control API's attack create/update routes, which validate
 * resource refs via FK constraints alone and have no existing pre-check
 * chokepoint to extend. Returns human-readable `label(id)` refs, split by
 * reason, for any wordlist/rulelist/masklist reference that is a
 * reclaimed shell (`blob_reclaimed_at IS NOT NULL`) or archived
 * (`archived_at IS NOT NULL`) — attacks never reference a hash list
 * directly (that's a campaign-level field), so hashLists is intentionally
 * not part of this check.
 */
export async function findReclaimedResourceRefs(
  projectId: number,
  refs: {
    wordlistId?: number | null | undefined
    rulelistId?: number | null | undefined
    masklistId?: number | null | undefined
  }
): Promise<{ reclaimed: string[]; archived: string[] }> {
  const archivableKeys: ReadonlyArray<Exclude<ArchivableKey, 'hashListId'>> = [
    'wordlistId',
    'rulelistId',
    'masklistId',
  ]
  const results = await Promise.all(
    archivableKeys
      .filter((key) => refs[key] != null)
      .map(async (key) => {
        const id = refs[key]
        if (id == null) return { reclaimed: [] as string[], archived: [] as string[] }
        const { archivedIds, reclaimedIds } = await lookupExistingArchivedReclaimed(
          key,
          [id],
          projectId
        )
        const label = ARCHIVABLE_LOOKUPS[key].label
        return {
          reclaimed: reclaimedIds.map((rid) => `${label}(${rid})`),
          archived: archivedIds.map((aid) => `${label}(${aid})`),
        }
      })
  )
  return {
    reclaimed: results.flatMap((r) => r.reclaimed),
    archived: results.flatMap((r) => r.archived),
  }
}

// ─── Single-hash-mode-per-campaign enforcement (issue #100 R15 / AS1) ────
//
// The campaign ETA rollup sums per-attack `estimateSecondsRemaining`
// across every non-terminal attack in a campaign. That sum is only the
// correct expected search time when every non-terminal attack shares one
// fleet-throughput figure — i.e. one hashcat mode. Nothing at the schema
// layer prevents a mixed-mode campaign, so this check makes single-mode
// an enforced invariant at attack write time rather than an assumption.
//
// Standalone (mirrors `findReclaimedResourceRefs` above) because the
// Control API attack routes (`routes/control/attacks.ts`) never call
// `validateCampaignResources` — they validate resource refs via FK
// constraints alone. Burying this inside `validateCampaignResources`
// would silently skip the Control surface.

export type ModeConsistencyResult =
  | { valid: true }
  | { valid: false; conflictingMode: number; conflictingAttackId: number }

/**
 * Verify `newMode` matches every other non-terminal (pending/running/
 * paused), non-archived attack already in `campaignId`. A campaign with
 * no such siblings (first attack, or every existing attack has reached a
 * terminal status / is archived) passes THIS pre-check — mixed-mode history
 * from before this check landed is out of scope for the friendly path (see
 * plan AS1).
 *
 * This is the operator-friendly pre-check, not the authority: issue #100 also
 * adds a DB-level composite FK (`attacks(campaign_id, mode)` ->
 * `campaigns(id, hashcat_mode)`) that enforces one mode across the campaign's
 * ENTIRE attack history, including terminal and archived rows. So a write that
 * passes here can still be rejected by the FK (surfaced as the same typed 422)
 * when a terminal/archived sibling holds a different mode. The pre-check exists
 * to return a clear message in the common case; the FK is the race/history
 * backstop.
 *
 * Reuses `deriveAttackRuntimes` for the status ladder rather than
 * re-deriving it from task aggregates here, so this check can never drift
 * from the read-time status the dashboard and Control surfaces already
 * show (issue #99).
 *
 * `excludeAttackId` lets the update path exclude the attack being
 * updated from its own sibling set.
 */
export async function checkSingleHashModePerCampaign(
  campaignId: number,
  newMode: number,
  excludeAttackId?: number
): Promise<ModeConsistencyResult> {
  // Archived attacks are hidden from the campaign editor / scheduler
  // (schema.ts comment on `attacks.archivedAt`) — a user creating a new
  // attack has no visibility into an archived sibling's mode, so it does
  // not count as a conflicting sibling here (mirrors `listAttacks()`'s
  // default exclusion of archived rows).
  const isSibling =
    excludeAttackId === undefined
      ? and(eq(attacks.campaignId, campaignId), isNull(attacks.archivedAt))
      : and(
          eq(attacks.campaignId, campaignId),
          isNull(attacks.archivedAt),
          ne(attacks.id, excludeAttackId)
        )

  const siblingRows = await db
    .select({
      id: attacks.id,
      campaignId: attacks.campaignId,
      projectId: attacks.projectId,
      mode: attacks.mode,
      keyspace: attacks.keyspace,
    })
    .from(attacks)
    .where(isSibling)

  if (siblingRows.length === 0) return { valid: true }

  const runtimes = await deriveAttackRuntimes(siblingRows)
  const conflictingSibling = siblingRows.find((row) => {
    if (row.mode === newMode) return false
    const status = runtimes.get(row.id)?.status ?? 'pending'
    return isNonTerminalAttackStatus(status)
  })

  return conflictingSibling
    ? {
        valid: false,
        conflictingMode: conflictingSibling.mode,
        conflictingAttackId: conflictingSibling.id,
      }
    : { valid: true }
}

// ─── DB-level TOCTOU backstop (issue #100) ───────────────────────────
//
// `checkSingleHashModePerCampaign` above is a read-then-write pre-check —
// two concurrent requests can both read "no conflicting sibling" before
// either write lands, so it cannot close the race on its own. The
// composite FK `attacks_campaign_id_mode_campaigns_id_hashcat_mode_fk`
// (attacks(campaign_id, mode) -> campaigns(id, hashcat_mode), schema.ts)
// is the actual backstop: the race loser's write violates SQLSTATE 23503,
// which the write paths below map to the same typed conflict outcome the
// pre-check returns.
//
// Deliberately narrow and NOT the general-purpose `isForeignKeyViolation`
// in services/resources.ts — this only ever needs to recognize this one
// constraint, scoped to this one invariant, so it doesn't carry the
// broader helper's legacy-mock compatibility surface or affect any other
// FK-violation call site in the codebase.

/** The composite FK this module's write paths detect a race against. */
export const MODE_CONSISTENCY_FK_CONSTRAINT =
  'attacks_campaign_id_mode_campaigns_id_hashcat_mode_fk'

/**
 * Detect the single-hash-mode-per-campaign composite FK violation
 * (SQLSTATE 23503, `constraint_name` matching {@link MODE_CONSISTENCY_FK_CONSTRAINT}).
 *
 * drizzle-orm (0.45.x) wraps every query failure in a `DrizzleQueryError`
 * whose `.cause` carries the real driver error — checks both `err` and
 * `err.cause` so it recognizes the violation whether the caller passes
 * the wrapper or an already-unwrapped/synthetic error (e.g. in tests).
 * postgres-js surfaces the constraint name as `constraint_name` on its
 * `PostgresError`.
 */
export function isModeConsistencyFkViolation(err: unknown): boolean {
  const candidates = [err, err instanceof Error ? (err as { cause?: unknown }).cause : undefined]
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) continue
    const code = 'code' in candidate ? (candidate as { code?: string }).code : undefined
    if (code !== '23503') continue
    const constraintName =
      'constraint_name' in candidate
        ? (candidate as { constraint_name?: string }).constraint_name
        : undefined
    if (constraintName === MODE_CONSISTENCY_FK_CONSTRAINT) return true
  }
  return false
}

function dedupIds<T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
  key: keyof T
): number[] {
  const out = new Set<number>()
  for (const row of rows) {
    const v = row[key]
    if (typeof v === 'number') out.add(v)
  }
  return Array.from(out)
}
