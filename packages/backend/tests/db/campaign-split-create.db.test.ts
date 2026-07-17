/**
 * Real-DB tests for issue #202 SU3 — campaign-wizard split + review flow.
 *
 * Covers the create-path branch (`createCampaignOrSplit`) and the confirm
 * flow (`confirmSplitCampaign`), including the KTD6 same-mode merge. Mirrors
 * `hash-list-split.db.test.ts`'s fixture conventions (SU2) — the confident
 * fixture is a SHA-512 Crypt string (`$6$...`, mode 1800) since a raw 32-hex
 * string is ambiguous (NTLM/LM/MD5/MD4 collide on length).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'

import { campaigns, hashItems, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { confirmSplitCampaign, createCampaignOrSplit } from '../../src/services/campaign-split.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SHA512_CRYPT_MODE = 1800
const NTLM_MODE = 1000
const HEX32_SIGNATURE = [0, 900, 1000, 3000]
const MERGE_SHARED_MODE = 9_999_101
const MERGE_OTHER_MODE_A = 9_999_102
const MERGE_OTHER_MODE_B = 9_999_103

function sha512Crypt(salt: string): string {
  return `$6$${salt}$${'A'.repeat(86)}`
}

const HEX32 = 'c'.repeat(32)

function garbage(i: number): string {
  return `garbage-unidentifiable-line-${i}`
}

function mixedTypeAnalysis(overrides: Partial<HashListTypeAnalysis> = {}): HashListTypeAnalysis {
  return {
    verdict: 'mixed',
    detectedModes: [],
    unidentifiedCount: 0,
    scannedCount: 0,
    sampled: false,
    declaredMode: null,
    analyzedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ = 'campaign-split-create-proj'

let projId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ))
}

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ, slug: SLUG_PROJ })
    .returning({ id: projects.id })
  projId = p!.id
})

afterAll(async () => {
  await cleanup()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createHashList(
  name: string,
  typeAnalysis: HashListTypeAnalysis | null = null,
  parentHashListId: number | null = null
): Promise<number> {
  const [list] = await db
    .insert(hashLists)
    .values({ projectId: projId, name, status: 'ready', typeAnalysis, parentHashListId })
    .returning({ id: hashLists.id })
  return list!.id
}

async function insertHashValues(hashListId: number, values: readonly string[]): Promise<void> {
  if (values.length === 0) return
  await db.insert(hashItems).values(values.map((hashValue) => ({ hashListId, hashValue })))
}

async function childrenOf(parentHashListId: number) {
  return db.select().from(hashLists).where(eq(hashLists.parentHashListId, parentHashListId))
}

async function campaignsOn(hashListId: number) {
  return db.select().from(campaigns).where(eq(campaigns.hashListId, hashListId))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createCampaignOrSplit + confirmSplitCampaign — mixed list full flow', () => {
  it('splits, resolves the ambiguous group, and creates a parent + one sub-campaign per resolved sub-list', async () => {
    const parentId = await createHashList('split-confirm-mixed-parent', mixedTypeAnalysis())
    const confidentValues = [sha512Crypt('salt0001'), sha512Crypt('salt0002')]
    const ambiguousValues = [HEX32, 'd'.repeat(32)]
    const unidentifiedValues = [garbage(0)]
    await insertHashValues(parentId, [
      ...confidentValues,
      ...ambiguousValues,
      ...unidentifiedValues,
    ])

    const createResult = await createCampaignOrSplit({
      projectId: projId,
      name: 'mixed-campaign',
      hashListId: parentId,
      attacks: [],
    })

    expect(createResult.kind).toBe('split_review')
    if (createResult.kind !== 'split_review') throw new Error('expected split_review')
    expect(createResult.confident).toHaveLength(1)
    expect(createResult.confident[0]?.mode).toBe(SHA512_CRYPT_MODE)
    expect(createResult.ambiguous).toHaveLength(1)
    expect(createResult.ambiguous[0]?.candidateModes).toEqual(HEX32_SIGNATURE)
    expect(createResult.unidentified).toHaveLength(1)

    const ambiguousSubListId = createResult.ambiguous[0]!.id

    const confirmResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'mixed-campaign',
      assignments: [{ subListId: ambiguousSubListId, mode: NTLM_MODE }],
    })

    expect(confirmResult.kind).toBe('confirmed')
    if (confirmResult.kind !== 'confirmed') throw new Error('expected confirmed')

    // ── Parent campaign: no parent of its own, targets the original (now-shell) list ──
    expect(confirmResult.parentCampaign.parentCampaignId).toBeNull()
    expect(confirmResult.parentCampaign.hashListId).toBe(parentId)

    // ── One sub-campaign for the confident group, one for the newly-resolved ambiguous group ──
    expect(confirmResult.subCampaigns).toHaveLength(2)
    for (const sub of confirmResult.subCampaigns) {
      expect(sub.parentCampaignId).toBe(confirmResult.parentCampaign.id)
    }
    const modes = confirmResult.subCampaigns.map((s) => s.mode).sort((a, b) => a - b)
    expect(modes).toEqual([SHA512_CRYPT_MODE, NTLM_MODE].sort((a, b) => a - b))

    // ── DB-level: each sub-campaign row carries the latched hashcat_mode ──
    for (const sub of confirmResult.subCampaigns) {
      const rows = await campaignsOn(sub.hashListId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.hashcatMode).toBe(sub.mode)
      expect(rows[0]?.parentCampaignId).toBe(confirmResult.parentCampaign.id)
    }

    // ── The resolved ambiguous sub-list's items now carry detected_hashcat_mode + homogeneous type_analysis ──
    const resolvedItems = await db
      .select()
      .from(hashItems)
      .where(eq(hashItems.hashListId, ambiguousSubListId))
    expect(resolvedItems).toHaveLength(ambiguousValues.length)
    for (const item of resolvedItems) {
      expect(item.detectedHashcatMode).toBe(NTLM_MODE)
    }
    const [resolvedList] = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, ambiguousSubListId))
    expect(resolvedList!.typeAnalysis?.verdict).toBe('homogeneous')

    // ── The unidentified sub-list gets NO sub-campaign ──
    const unidentifiedSubListId = createResult.unidentified[0]!.id
    const unidentifiedCampaigns = await campaignsOn(unidentifiedSubListId)
    expect(unidentifiedCampaigns).toHaveLength(0)
  })
})

describe('confirmSplitCampaign — KTD6 same-mode merge', () => {
  it('merges two ambiguous groups assigned the same mode into one sub-list/sub-campaign', async () => {
    const parentId = await createHashList('split-confirm-merge-parent')

    const childAId = await createHashList(
      'split-confirm-merge-child-a',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: MERGE_SHARED_MODE, count: 2 },
          { hashcatMode: MERGE_OTHER_MODE_A, count: 2 },
        ],
        scannedCount: 2,
      }),
      parentId
    )
    const childBId = await createHashList(
      'split-confirm-merge-child-b',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: MERGE_SHARED_MODE, count: 3 },
          { hashcatMode: MERGE_OTHER_MODE_B, count: 3 },
        ],
        scannedCount: 3,
      }),
      parentId
    )

    await insertHashValues(childAId, ['merge-a-1', 'merge-a-2'])
    await insertHashValues(childBId, ['merge-b-1', 'merge-b-2', 'merge-b-3'])

    const confirmResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'merge-campaign',
      assignments: [
        { subListId: childAId, mode: MERGE_SHARED_MODE },
        { subListId: childBId, mode: MERGE_SHARED_MODE },
      ],
    })

    expect(confirmResult.kind).toBe('confirmed')
    if (confirmResult.kind !== 'confirmed') throw new Error('expected confirmed')

    // ── Only one sub-campaign for the merged mode ──
    expect(confirmResult.subCampaigns).toHaveLength(1)
    expect(confirmResult.subCampaigns[0]?.mode).toBe(MERGE_SHARED_MODE)

    // ── Merge target is the lower id (childA); its item count is the sum of both ──
    const targetId = confirmResult.subCampaigns[0]!.hashListId
    expect(targetId).toBe(childAId)
    const targetItems = await db.select().from(hashItems).where(eq(hashItems.hashListId, targetId))
    expect(targetItems).toHaveLength(5)
    for (const item of targetItems) {
      expect(item.detectedHashcatMode).toBe(MERGE_SHARED_MODE)
    }

    // ── The merged-away sub-list row no longer exists ──
    const [survivingB] = await db.select().from(hashLists).where(eq(hashLists.id, childBId))
    expect(survivingB).toBeUndefined()
  })
})

describe('createCampaignOrSplit — non-split regression + degenerate cases', () => {
  it('creates a plain campaign unchanged for a homogeneous list', async () => {
    const listId = await createHashList(
      'split-confirm-homogeneous',
      mixedTypeAnalysis({ verdict: 'homogeneous' })
    )
    await insertHashValues(listId, [sha512Crypt('homog0001')])

    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'homogeneous-campaign',
      hashListId: listId,
      attacks: [],
    })

    expect(result.kind).toBe('created')
    const children = await childrenOf(listId)
    expect(children).toHaveLength(0)
  })

  it('creates a plain campaign unchanged for a never-analyzed (null type_analysis) list', async () => {
    const listId = await createHashList('split-confirm-unanalyzed', null)
    await insertHashValues(listId, [sha512Crypt('unanalyzed01')])

    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'unanalyzed-campaign',
      hashListId: listId,
      attacks: [],
    })

    expect(result.kind).toBe('created')
  })

  it('falls back to a plain campaign with no scaffolding when the split classifier degenerates to a single group', async () => {
    const listId = await createHashList('split-confirm-degenerate-single', mixedTypeAnalysis())
    // All items classify to the SAME confident group despite the
    // ingestion-time "mixed" verdict — planSplit collapses to one group.
    await insertHashValues(listId, [sha512Crypt('deg00001'), sha512Crypt('deg00002')])

    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'degenerate-single-campaign',
      hashListId: listId,
      attacks: [],
    })

    expect(result.kind).toBe('created')
    const children = await childrenOf(listId)
    expect(children).toHaveLength(0)
    const items = await db.select().from(hashItems).where(eq(hashItems.hashListId, listId))
    expect(items).toHaveLength(2)
  })

  it('returns split_empty and creates no campaign for an empty mixed-verdict list', async () => {
    const listId = await createHashList('split-confirm-degenerate-empty', mixedTypeAnalysis())

    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'degenerate-empty-campaign',
      hashListId: listId,
      attacks: [],
    })

    expect(result.kind).toBe('split_empty')
    const rows = await campaignsOn(listId)
    expect(rows).toHaveLength(0)
    const children = await childrenOf(listId)
    expect(children).toHaveLength(0)
  })
})
