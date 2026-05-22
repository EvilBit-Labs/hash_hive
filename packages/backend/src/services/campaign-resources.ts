/**
 * Cross-project resource validator for campaigns and attacks.
 *
 * Extracted from `services/campaigns.ts` to keep that module under the
 * project's 800-line file-size guideline. The function is unchanged in
 * behavior — only relocated. Callers (transitionCampaign,
 * createCampaignWithAttacks, the standalone attack-write routes) keep
 * importing through the `services/campaigns.ts` facade.
 */
import { hashLists, hashTypes, maskLists, ruleLists, wordLists } from '@hashhive/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';

type ResourceLookupKey = 'hashListId' | 'hashTypeId' | 'wordlistId' | 'rulelistId' | 'masklistId';

interface ResourceLookupSpec {
  // biome-ignore lint/suspicious/noExplicitAny: drizzle table shapes are heterogeneous; the helper only uses .id and .projectId which exist on each row
  table: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  idColumn: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  projectIdColumn: any | null;
  label: string;
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
    label: 'maskList',
  },
};

async function lookupExistingIds(
  spec: ResourceLookupSpec,
  wanted: readonly number[],
  projectId: number
): Promise<Set<number>> {
  if (wanted.length === 0) return new Set();
  const whereClause = spec.projectIdColumn
    ? and(inArray(spec.idColumn, wanted as number[]), eq(spec.projectIdColumn, projectId))
    : inArray(spec.idColumn, wanted as number[]);
  const rows = await db.select({ id: spec.idColumn }).from(spec.table).where(whereClause);
  return new Set((rows as Array<{ id: number }>).map((r) => r.id));
}

/**
 * Verify every resource referenced by the campaign and its attacks
 * actually exists, and (for project-scoped resources) belongs to the
 * campaign's project. Returns the missing resource identifiers grouped
 * by table so the route layer can surface a single combined error.
 *
 * Runs one parallel SELECT per table; all resource id lookups are
 * indexed by primary key.
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
    hashTypeId?: number | null | undefined;
    wordlistId?: number | null | undefined;
    rulelistId?: number | null | undefined;
    masklistId?: number | null | undefined;
  }>
): Promise<{ valid: true } | { valid: false; missing: string[] }> {
  // Collect dedup'd id lists per resource type. Null campaign.hashListId
  // is the documented "skip" signal — keep the wanted list empty so the
  // helper produces no lookup for that dimension.
  const wanted: Record<ResourceLookupKey, number[]> = {
    hashListId: campaign.hashListId != null ? [campaign.hashListId] : [],
    hashTypeId: dedupIds(campaignAttacks, 'hashTypeId'),
    wordlistId: dedupIds(campaignAttacks, 'wordlistId'),
    rulelistId: dedupIds(campaignAttacks, 'rulelistId'),
    masklistId: dedupIds(campaignAttacks, 'masklistId'),
  };

  const lookupKeys = (Object.keys(RESOURCE_LOOKUPS) as ResourceLookupKey[]).filter(
    (k) => wanted[k].length > 0
  );
  if (lookupKeys.length === 0) {
    return { valid: true };
  }

  // Run in parallel — every lookup is a single indexed SELECT.
  const results = await Promise.all(
    lookupKeys.map(async (key) => ({
      key,
      foundIds: await lookupExistingIds(RESOURCE_LOOKUPS[key], wanted[key], campaign.projectId),
    }))
  );

  const missing: string[] = [];
  for (const { key, foundIds } of results) {
    const label = RESOURCE_LOOKUPS[key].label;
    for (const id of wanted[key]) {
      if (!foundIds.has(id)) {
        missing.push(`${label}(${id})`);
      }
    }
  }

  return missing.length === 0 ? { valid: true } : { valid: false, missing };
}

function dedupIds<T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
  key: keyof T
): number[] {
  const out = new Set<number>();
  for (const row of rows) {
    const v = row[key];
    if (typeof v === 'number') out.add(v);
  }
  return Array.from(out);
}
