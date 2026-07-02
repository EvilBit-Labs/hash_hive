/**
 * Cross-project resource validator for campaigns and attacks.
 *
 * Extracted from `services/campaigns.ts` to keep that module under the
 * project's 800-line file-size guideline. The function is unchanged in
 * behavior — only relocated. Callers (transitionCampaign,
 * createCampaignWithAttacks, the standalone attack-write routes) keep
 * importing through the `services/campaigns.ts` facade.
 */
import { hashLists, hashTypes, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { and, eq, inArray } from 'drizzle-orm'

import { db } from '../db/index.js'

type ResourceLookupKey = 'hashListId' | 'hashTypeId' | 'wordlistId' | 'rulelistId' | 'masklistId'

// Each of the 5 resource tables is a Drizzle pgTable carrying an
// integer `id` column and (for everything except hashTypes) a
// `projectId` column. Modeling the union explicitly drops the `any`
// holes the prior version carried; the helper only needs `.id` and
// optionally `.projectId`, both of which are present on every member
// of the union.
type ResourceTable =
  | typeof hashLists
  | typeof hashTypes
  | typeof wordLists
  | typeof ruleLists
  | typeof maskLists

interface ResourceLookupSpec {
  table: ResourceTable
  idColumn:
    | typeof hashLists.id
    | typeof hashTypes.id
    | typeof wordLists.id
    | typeof ruleLists.id
    | typeof maskLists.id
  // hashTypes is global (no `projectId` column), so this is nullable
  // and the helper switches off it.
  projectIdColumn:
    | typeof hashLists.projectId
    | typeof wordLists.projectId
    | typeof ruleLists.projectId
    | typeof maskLists.projectId
    | null
  label: string
}

const RESOURCE_LOOKUPS: Record<ResourceLookupKey, ResourceLookupSpec> = {
  hashListId: {
    table: hashLists,
    idColumn: hashLists.id,
    projectIdColumn: hashLists.projectId,
    label: 'hashList',
  },
  hashTypeId: {
    table: hashTypes,
    idColumn: hashTypes.id,
    projectIdColumn: null, // global, no project scope
    label: 'hashType',
  },
  wordlistId: {
    table: wordLists,
    idColumn: wordLists.id,
    projectIdColumn: wordLists.projectId,
    label: 'wordlist',
  },
  rulelistId: {
    table: ruleLists,
    idColumn: ruleLists.id,
    projectIdColumn: ruleLists.projectId,
    label: 'rulelist',
  },
  masklistId: {
    table: maskLists,
    idColumn: maskLists.id,
    projectIdColumn: maskLists.projectId,
    label: 'masklist',
  },
}

async function lookupExistingIds(
  spec: ResourceLookupSpec,
  wanted: readonly number[],
  projectId: number
): Promise<Set<number>> {
  if (wanted.length === 0) return new Set()
  const whereClause = spec.projectIdColumn
    ? and(inArray(spec.idColumn, [...wanted]), eq(spec.projectIdColumn, projectId))
    : inArray(spec.idColumn, [...wanted])
  const rows = await db.select({ id: spec.idColumn }).from(spec.table).where(whereClause)
  return new Set(rows.map((r) => r.id))
}

// ─── Reclaimed-shell lookups (issue #106 U11/U12) ────────────────────
//
// Only word/rule/mask lists carry `blob_reclaimed_at` (hash lists are
// excluded from blob reclamation — their forensic value is the in-DB
// `hash_items`, not a retained source file). A dedicated, concretely-typed
// map (rather than reusing `RESOURCE_LOOKUPS`, whose `table` field is a
// 5-member union that doesn't statically carry `blobReclaimedAt`) avoids an
// unsafe cast.

type ReclaimableKey = 'wordlistId' | 'rulelistId' | 'masklistId'

const RECLAIMABLE_LOOKUPS: Record<
  ReclaimableKey,
  {
    table: typeof wordLists | typeof ruleLists | typeof maskLists
    idColumn: typeof wordLists.id | typeof ruleLists.id | typeof maskLists.id
    projectIdColumn:
      | typeof wordLists.projectId
      | typeof ruleLists.projectId
      | typeof maskLists.projectId
    blobReclaimedAtColumn:
      | typeof wordLists.blobReclaimedAt
      | typeof ruleLists.blobReclaimedAt
      | typeof maskLists.blobReclaimedAt
    label: string
  }
> = {
  wordlistId: {
    table: wordLists,
    idColumn: wordLists.id,
    projectIdColumn: wordLists.projectId,
    blobReclaimedAtColumn: wordLists.blobReclaimedAt,
    label: 'wordlist',
  },
  rulelistId: {
    table: ruleLists,
    idColumn: ruleLists.id,
    projectIdColumn: ruleLists.projectId,
    blobReclaimedAtColumn: ruleLists.blobReclaimedAt,
    label: 'rulelist',
  },
  masklistId: {
    table: maskLists,
    idColumn: maskLists.id,
    projectIdColumn: maskLists.projectId,
    blobReclaimedAtColumn: maskLists.blobReclaimedAt,
    label: 'masklist',
  },
}

/**
 * Existence + reclaimed-shell status in ONE query (issue #106 U12): selects
 * `{id, blobReclaimedAt}` instead of firing a second SELECT per table.
 * Folding both checks into a single read is both cheaper and more correct
 * than two separate reads (one snapshot, no window for the two checks to
 * observe different states of the same row).
 */
async function lookupExistingAndReclaimed(
  key: ReclaimableKey,
  wanted: readonly number[],
  projectId: number
): Promise<{ foundIds: Set<number>; reclaimedIds: number[] }> {
  if (wanted.length === 0) return { foundIds: new Set(), reclaimedIds: [] }
  const spec = RECLAIMABLE_LOOKUPS[key]
  const rows = await db
    .select({ id: spec.idColumn, blobReclaimedAt: spec.blobReclaimedAtColumn })
    .from(spec.table)
    .where(and(inArray(spec.idColumn, [...wanted]), eq(spec.projectIdColumn, projectId)))
  return {
    foundIds: new Set(rows.map((r) => r.id)),
    reclaimedIds: rows.filter((r) => r.blobReclaimedAt != null).map((r) => r.id),
  }
}

/**
 * Verify every resource referenced by the campaign and its attacks
 * actually exists, and (for project-scoped resources) belongs to the
 * campaign's project. Also flags any word/rule/mask list reference that is
 * a reclaimed shell (issue #106 U12 / R12) — present, but unusable until
 * re-uploaded and checksum-verified. Returns the missing/reclaimed resource
 * identifiers grouped by table so the route layer can surface a single
 * combined error.
 *
 * Runs one SELECT per referenced table (word/rule/mask lists fold the
 * reclaimed-shell check into their existence SELECT rather than firing a
 * second query — see `lookupExistingAndReclaimed`); all resource id lookups
 * are indexed by primary key.
 *
 * Project scoping (driven by per-resource `projectScoped` flag):
 *   - `hashLists`, `wordLists`, `ruleLists`, `maskLists` have
 *     `project_id` and are scoped to the campaign's project.
 *   - `hashTypes` is global (no project_id) so it's looked up by id only.
 *
 * Null `campaign.hashListId` is a legitimate caller signal: standalone
 * attack-write callers (POST /:id/attacks, PATCH /:id/attacks/:attackId)
 * pass `null` to mean "no hash-list dimension to validate here — the
 * parent campaign's hashList was already validated when the campaign
 * itself was created." The campaign table requires hashListId to be
 * non-null at the DB layer, so `transitionCampaign` callers always
 * supply a real id.
 */
export async function validateCampaignResources(
  campaign: { projectId: number; hashListId: number | null },
  campaignAttacks: ReadonlyArray<{
    hashTypeId?: number | null | undefined
    wordlistId?: number | null | undefined
    rulelistId?: number | null | undefined
    masklistId?: number | null | undefined
  }>
): Promise<{ valid: true } | { valid: false; missing: string[]; reclaimed: string[] }> {
  // Collect dedup'd id lists per resource type. Null campaign.hashListId
  // is the documented "skip" signal — keep the wanted list empty so the
  // helper produces no lookup for that dimension.
  const wanted: Record<ResourceLookupKey, number[]> = {
    hashListId: campaign.hashListId != null ? [campaign.hashListId] : [],
    hashTypeId: dedupIds(campaignAttacks, 'hashTypeId'),
    wordlistId: dedupIds(campaignAttacks, 'wordlistId'),
    rulelistId: dedupIds(campaignAttacks, 'rulelistId'),
    masklistId: dedupIds(campaignAttacks, 'masklistId'),
  }

  const reclaimableKeySet = new Set<ResourceLookupKey>(['wordlistId', 'rulelistId', 'masklistId'])
  const lookupKeys = (Object.keys(RESOURCE_LOOKUPS) as ResourceLookupKey[]).filter(
    (k) => wanted[k].length > 0
  )

  if (lookupKeys.length === 0) {
    return { valid: true }
  }

  // Run in parallel — every lookup is a single indexed SELECT (one per
  // referenced table, not per key). hashListId/hashTypeId use the plain
  // existence-only lookup; wordlistId/rulelistId/masklistId use the
  // combined existence + reclaimed-shell lookup (issue #106 U12).
  const results = await Promise.all(
    lookupKeys.map(async (key) => {
      if (reclaimableKeySet.has(key)) {
        const { foundIds, reclaimedIds } = await lookupExistingAndReclaimed(
          key as ReclaimableKey,
          wanted[key],
          campaign.projectId
        )
        return { key, foundIds, reclaimedIds }
      }
      const foundIds = await lookupExistingIds(
        RESOURCE_LOOKUPS[key],
        wanted[key],
        campaign.projectId
      )
      return { key, foundIds, reclaimedIds: [] as number[] }
    })
  )

  const missing: string[] = []
  const reclaimed: string[] = []
  for (const { key, foundIds, reclaimedIds } of results) {
    const label = RESOURCE_LOOKUPS[key].label
    for (const id of wanted[key]) {
      if (!foundIds.has(id)) {
        missing.push(`${label}(${id})`)
      }
    }
    for (const id of reclaimedIds) {
      reclaimed.push(`${label}(${id})`)
    }
  }

  return missing.length === 0 && reclaimed.length === 0
    ? { valid: true }
    : { valid: false, missing, reclaimed }
}

/**
 * Standalone reclaimed-shell check for callers that don't go through
 * `validateCampaignResources` (issue #106 U12 / R12) — currently the
 * Control API's attack create/update routes, which validate resource refs
 * via FK constraints alone and have no existing pre-check chokepoint to
 * extend. Returns human-readable `label(id)` refs for any wordlist/
 * rulelist/masklist reference that is a reclaimed shell (present, but
 * `blob_reclaimed_at IS NOT NULL`).
 */
export async function findReclaimedResourceRefs(
  projectId: number,
  refs: {
    wordlistId?: number | null | undefined
    rulelistId?: number | null | undefined
    masklistId?: number | null | undefined
  }
): Promise<string[]> {
  const reclaimableKeys: ReadonlyArray<ReclaimableKey> = ['wordlistId', 'rulelistId', 'masklistId']
  const results = await Promise.all(
    reclaimableKeys
      .filter((key) => refs[key] != null)
      .map(async (key) => {
        const id = refs[key]
        if (id == null) return []
        const { reclaimedIds } = await lookupExistingAndReclaimed(key, [id], projectId)
        return reclaimedIds.map((rid) => `${RECLAIMABLE_LOOKUPS[key].label}(${rid})`)
      })
  )
  return results.flat()
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
