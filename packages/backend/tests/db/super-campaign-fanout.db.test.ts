/**
 * Real-DB tests for issue #101 U10 — targeting a SuperHashlist fans out one
 * typed sub-campaign per resolved LEAF list (KTD6a).
 *
 * Covers:
 *   - AE4 (reframed per KTD6a): a super whose NTLM / sha512crypt /
 *     network-device hashes each live in exactly one typed leaf launches
 *     exactly three sub-campaigns, one per typed leaf, each with the right
 *     latched mode (no type attacked with the wrong mode).
 *   - A type spanning two members yields two zap-deduped sub-campaigns (still
 *     one mode each) — the count follows LEAVES, and both target the same mode.
 *   - A member that is itself a #202 split parent resolves to its physical
 *     children; each child is a typed leaf sub-campaign.
 *   - Run-time dedup precondition (U3): a value present in two members'
 *     same-mode leaves lands as two separate sub-campaigns under one parent
 *     (the actual zap dedup is U3's concern; here we assert the fan-out shape).
 *   - Archived super → rejected with a clean typed error.
 *   - Fewer than 2 members → rejected (R2 enforced at target time).
 *   - Idempotency: re-running after a partial failure does not duplicate
 *     sub-campaigns (keyed on superHashListId + parentCampaignId IS NULL).
 *   - Agent wire unchanged: every sub-campaign targets one physical leaf
 *     `hashListId` with a latched single mode; the parent carries
 *     `superHashListId` and NO `hashListId`.
 *
 * Mirrors `campaign-split-create.db.test.ts`'s fixture conventions. Runs under
 * `just test-db` (preload: tests/preload-db.ts) with the shared drizzle client.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'

import {
  campaigns,
  hashItems,
  hashLists,
  projects,
  superHashListMembers,
  superHashLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { createSuperCampaign } from '../../src/services/campaign-split.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NTLM_MODE = 1000
const SHA512_CRYPT_MODE = 1800
const NETWORK_DEVICE_MODE = 5700 // Cisco-IOS type 4 (SHA256)

const SLUG_PROJ = 'super-campaign-fanout-proj'

let projId: number

function homogeneous(mode: number, count = 1): HashListTypeAnalysis {
  return {
    verdict: 'homogeneous',
    detectedModes: [{ hashcatMode: mode, count }],
    unidentifiedCount: 0,
    scannedCount: count,
    sampled: false,
    declaredMode: null,
    analyzedAt: new Date().toISOString(),
  }
}

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

async function createSuper(name: string, memberIds: number[]): Promise<number> {
  const [superRow] = await db
    .insert(superHashLists)
    .values({ projectId: projId, name })
    .returning({ id: superHashLists.id })
  const superId = superRow!.id
  if (memberIds.length > 0) {
    await db
      .insert(superHashListMembers)
      .values(memberIds.map((memberHashListId) => ({ superHashListId: superId, memberHashListId })))
  }
  return superId
}

async function subCampaignRows(parentCampaignId: number) {
  return db.select().from(campaigns).where(eq(campaigns.parentCampaignId, parentCampaignId))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createSuperCampaign — AE4 reframed: one typed sub-campaign per typed leaf', () => {
  it('a super with NTLM + sha512crypt + network-device each in exactly one leaf launches exactly three sub-campaigns, one per typed leaf, no wrong mode', async () => {
    const ntlmList = await createHashList('ae4-ntlm', homogeneous(NTLM_MODE))
    const shaList = await createHashList('ae4-sha512crypt', homogeneous(SHA512_CRYPT_MODE))
    const netList = await createHashList('ae4-network', homogeneous(NETWORK_DEVICE_MODE))
    await insertHashValues(ntlmList, ['a'.repeat(32)])
    await insertHashValues(shaList, ['$6$salt$' + 'A'.repeat(86)])
    await insertHashValues(netList, ['b'.repeat(64)])

    const superId = await createSuper('ae4-super', [ntlmList, shaList, netList])

    const result = await createSuperCampaign({
      projectId: projId,
      name: 'ae4-campaign',
      superHashListId: superId,
      createdBy: null,
    })

    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('expected created')

    // ── Parent campaign: carries superHashListId, NO hashListId, no parent ──
    expect(result.parentCampaign.superHashListId).toBe(superId)
    expect(result.parentCampaign.hashListId).toBeNull()
    expect(result.parentCampaign.parentCampaignId).toBeNull()

    // ── Exactly three sub-campaigns — one per typed LEAF ──
    expect(result.subCampaigns).toHaveLength(3)

    // Each leaf targeted with its own mode; no type attacked with the wrong mode.
    const modeByLeaf = new Map(result.subCampaigns.map((s) => [s.hashListId, s.mode]))
    expect(modeByLeaf.get(ntlmList)).toBe(NTLM_MODE)
    expect(modeByLeaf.get(shaList)).toBe(SHA512_CRYPT_MODE)
    expect(modeByLeaf.get(netList)).toBe(NETWORK_DEVICE_MODE)

    // ── Agent wire unchanged: every sub-campaign row targets one physical
    // leaf hashListId with a latched single mode, links to the parent, and
    // carries NO superHashListId. ──
    const subs = await subCampaignRows(result.parentCampaign.id)
    expect(subs).toHaveLength(3)
    for (const sub of subs) {
      expect(sub.hashListId).not.toBeNull()
      expect(sub.superHashListId).toBeNull()
      expect(sub.parentCampaignId).toBe(result.parentCampaign.id)
      expect(sub.hashcatMode).toBe(modeByLeaf.get(sub.hashListId!)!)
    }
  })
})

describe('createSuperCampaign — a type spanning two members yields two zap-deduped leaves', () => {
  it('two NTLM members each become their own single-mode sub-campaign; count follows LEAVES and both target the same mode', async () => {
    const ntlmA = await createHashList('span-ntlm-a', homogeneous(NTLM_MODE))
    const ntlmB = await createHashList('span-ntlm-b', homogeneous(NTLM_MODE))
    // A value present in BOTH members' same-mode leaves — run-time dedup (U3)
    // collapses it to one crack; structurally it remains two sub-campaigns.
    const sharedValue = 'c'.repeat(32)
    await insertHashValues(ntlmA, [sharedValue, 'd'.repeat(32)])
    await insertHashValues(ntlmB, [sharedValue, 'e'.repeat(32)])

    const superId = await createSuper('span-super', [ntlmA, ntlmB])

    const result = await createSuperCampaign({
      projectId: projId,
      name: 'span-campaign',
      superHashListId: superId,
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('expected created')

    // Count follows LEAVES — two members of the same type → two sub-campaigns.
    expect(result.subCampaigns).toHaveLength(2)
    const targeted = result.subCampaigns.map((s) => s.hashListId).sort((a, b) => a - b)
    expect(targeted).toEqual([ntlmA, ntlmB].toSorted((a, b) => a - b))
    // Both target the SAME mode (still one mode each).
    for (const sub of result.subCampaigns) {
      expect(sub.mode).toBe(NTLM_MODE)
    }
    // Structural dedup precondition: both leaves are separate sub-campaigns
    // under the same parent — the actual crack-once is U3's zap dedup.
    for (const sub of result.subCampaigns) {
      expect(sub.parentCampaignId).toBe(result.parentCampaign.id)
    }
  })
})

describe('createSuperCampaign — a member that is a #202 split parent resolves to its physical children', () => {
  it('expands a split-parent member one further level; each child is a typed leaf sub-campaign', async () => {
    // A homogeneous plain member...
    const plainMember = await createHashList('mixed-plain-member', homogeneous(SHA512_CRYPT_MODE))
    await insertHashValues(plainMember, ['$6$s$' + 'B'.repeat(86)])

    // ...and a #202 split PARENT member (a shell) with two homogeneous
    // physical children (its typed leaves).
    const splitParent = await createHashList('mixed-split-parent', {
      verdict: 'mixed',
      detectedModes: [],
      unidentifiedCount: 0,
      scannedCount: 0,
      sampled: false,
      declaredMode: null,
      analyzedAt: new Date().toISOString(),
    })
    const childNtlm = await createHashList('mixed-child-ntlm', homogeneous(NTLM_MODE), splitParent)
    const childNet = await createHashList(
      'mixed-child-net',
      homogeneous(NETWORK_DEVICE_MODE),
      splitParent
    )
    await insertHashValues(childNtlm, ['f'.repeat(32)])
    await insertHashValues(childNet, ['0'.repeat(64)])

    const superId = await createSuper('mixed-super', [plainMember, splitParent])

    const result = await createSuperCampaign({
      projectId: projId,
      name: 'mixed-campaign',
      superHashListId: superId,
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('expected created')

    // Three leaves total: the plain member + the split parent's two children.
    // The split PARENT itself is never a leaf (it is an empty shell).
    const targeted = result.subCampaigns.map((s) => s.hashListId).sort((a, b) => a - b)
    expect(targeted).toEqual([plainMember, childNtlm, childNet].toSorted((a, b) => a - b))
    expect(result.subCampaigns.some((s) => s.hashListId === splitParent)).toBe(false)

    const modeByLeaf = new Map(result.subCampaigns.map((s) => [s.hashListId, s.mode]))
    expect(modeByLeaf.get(plainMember)).toBe(SHA512_CRYPT_MODE)
    expect(modeByLeaf.get(childNtlm)).toBe(NTLM_MODE)
    expect(modeByLeaf.get(childNet)).toBe(NETWORK_DEVICE_MODE)
  })
})

describe('createSuperCampaign — target-time guards', () => {
  it('rejects targeting an archived super with a clean error and creates no campaign', async () => {
    const a = await createHashList('archived-member-a', homogeneous(NTLM_MODE))
    const b = await createHashList('archived-member-b', homogeneous(SHA512_CRYPT_MODE))
    await insertHashValues(a, ['1'.repeat(32)])
    await insertHashValues(b, ['$6$z$' + 'C'.repeat(86)])
    const superId = await createSuper('archived-super', [a, b])
    await db
      .update(superHashLists)
      .set({ archivedAt: new Date() })
      .where(eq(superHashLists.id, superId))

    const result = await createSuperCampaign({
      projectId: projId,
      name: 'archived-campaign',
      superHashListId: superId,
    })
    expect(result.kind).toBe('super_archived')

    const parents = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.superHashListId, superId), isNull(campaigns.parentCampaignId)))
    expect(parents).toHaveLength(0)
  })

  it('rejects a super with fewer than 2 members (R2 enforced at target time)', async () => {
    const only = await createHashList('single-member', homogeneous(NTLM_MODE))
    await insertHashValues(only, ['2'.repeat(32)])
    const superId = await createSuper('single-member-super', [only])

    const result = await createSuperCampaign({
      projectId: projId,
      name: 'single-member-campaign',
      superHashListId: superId,
    })
    expect(result.kind).toBe('super_too_few_members')
    if (result.kind !== 'super_too_few_members') throw new Error('expected super_too_few_members')
    expect(result.memberCount).toBe(1)

    const parents = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.superHashListId, superId), isNull(campaigns.parentCampaignId)))
    expect(parents).toHaveLength(0)
  })

  it('returns super_not_found for a super in another project (project-scoped)', async () => {
    const result = await createSuperCampaign({
      projectId: projId,
      name: 'missing-campaign',
      superHashListId: 999_999_999,
    })
    expect(result.kind).toBe('super_not_found')
  })
})

describe('createSuperCampaign — idempotency (keyed on superHashListId + parentCampaignId IS NULL)', () => {
  it('re-running after a partial failure backfills the missing sub-campaign without duplicating the surviving one', async () => {
    const ntlm = await createHashList('idem-ntlm', homogeneous(NTLM_MODE))
    const sha = await createHashList('idem-sha', homogeneous(SHA512_CRYPT_MODE))
    await insertHashValues(ntlm, ['3'.repeat(32)])
    await insertHashValues(sha, ['$6$i$' + 'D'.repeat(86)])
    const superId = await createSuper('idem-super', [ntlm, sha])

    const first = await createSuperCampaign({
      projectId: projId,
      name: 'idem-campaign',
      superHashListId: superId,
    })
    expect(first.kind).toBe('created')
    if (first.kind !== 'created') throw new Error('expected created')
    expect(first.subCampaigns).toHaveLength(2)

    // Simulate a crash after the parent + ONE sub-campaign were created:
    // delete one sub-campaign row to reproduce the partial state.
    const survivingSub = first.subCampaigns.find((s) => s.hashListId === ntlm)!
    const missingSub = first.subCampaigns.find((s) => s.hashListId === sha)!
    await db.delete(campaigns).where(eq(campaigns.id, missingSub.id))

    const retry = await createSuperCampaign({
      projectId: projId,
      name: 'idem-campaign',
      superHashListId: superId,
    })
    expect(retry.kind).toBe('created')
    if (retry.kind !== 'created') throw new Error('expected created')

    // Same parent campaign — never re-created.
    expect(retry.parentCampaign.id).toBe(first.parentCampaign.id)

    // The surviving sub-campaign is returned UNCHANGED (same id); the missing
    // one is backfilled fresh.
    expect(retry.subCampaigns).toHaveLength(2)
    const retrySurviving = retry.subCampaigns.find((s) => s.hashListId === ntlm)
    const retryBackfilled = retry.subCampaigns.find((s) => s.hashListId === sha)
    expect(retrySurviving?.id).toBe(survivingSub.id)
    expect(retryBackfilled?.id).not.toBe(missingSub.id)
    expect(retryBackfilled?.mode).toBe(SHA512_CRYPT_MODE)

    // DB-level: exactly one campaign row per leaf under this parent.
    const subs = await subCampaignRows(retry.parentCampaign.id)
    expect(subs).toHaveLength(2)
    // And exactly one un-parented parent campaign for this super.
    const parents = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.superHashListId, superId), isNull(campaigns.parentCampaignId)))
    expect(parents).toHaveLength(1)
  })

  it('a full re-run creates nothing new and returns the same sub-campaign set', async () => {
    const ntlm = await createHashList('idem-full-ntlm', homogeneous(NTLM_MODE))
    const sha = await createHashList('idem-full-sha', homogeneous(SHA512_CRYPT_MODE))
    await insertHashValues(ntlm, ['4'.repeat(32)])
    await insertHashValues(sha, ['$6$f$' + 'E'.repeat(86)])
    const superId = await createSuper('idem-full-super', [ntlm, sha])

    const first = await createSuperCampaign({
      projectId: projId,
      name: 'idem-full-campaign',
      superHashListId: superId,
    })
    expect(first.kind).toBe('created')
    if (first.kind !== 'created') throw new Error('expected created')

    const retry = await createSuperCampaign({
      projectId: projId,
      name: 'idem-full-campaign',
      superHashListId: superId,
    })
    expect(retry.kind).toBe('created')
    if (retry.kind !== 'created') throw new Error('expected created')

    expect(retry.parentCampaign.id).toBe(first.parentCampaign.id)
    const firstIds = first.subCampaigns.map((s) => s.id).sort((a, b) => a - b)
    const retryIds = retry.subCampaigns.map((s) => s.id).sort((a, b) => a - b)
    expect(retryIds).toEqual(firstIds)

    const subs = await subCampaignRows(retry.parentCampaign.id)
    expect(subs).toHaveLength(2)
  })
})
