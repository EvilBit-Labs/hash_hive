/**
 * Real-DB tests for issue #202 SU3/SU7 — campaign-wizard split + review flow.
 *
 * Covers the create-path branch (`createCampaignOrSplit`), the async status
 * poll (`getSplitStatus`), and the confirm flow (`confirmSplitCampaign`),
 * including the KTD6 same-mode merge. Mirrors `hash-list-split.db.test.ts`'s
 * fixture conventions (SU2) — the confident fixture is a SHA-512 Crypt
 * string (`$6$...`, mode 1800) since a raw 32-hex string is ambiguous
 * (NTLM/LM/MD5/MD4 collide on length).
 *
 * As of SU7, `createCampaignOrSplit` no longer runs `runSplitAnalysis`
 * inline — it enqueues a job and returns `split_pending`. The db test lane
 * has no live Redis (mirrors `hash-list-split.db.test.ts`), so these tests
 * call `runSplitAnalysis` directly to simulate the worker running the job,
 * then assert on `getSplitStatus`'s resulting status transition.
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
import { eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { runSplitAnalysis } from '../../src/queue/workers/hash-list-split.js'
import { getSplitStatus } from '../../src/services/campaign-split-status.js'
import {
  _campaignSplitDeps,
  confirmSplitCampaign,
  createCampaignOrSplit,
} from '../../src/services/campaign-split.js'

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

/**
 * The db test lane has no live Redis, so the real `getQueueManager()`
 * returns `undefined` — meaning `enqueueSplitJob` genuinely fails and
 * `createCampaignOrSplit` correctly reports `split_enqueue_failed` (code
 * review fix; see the dedicated "enqueue failure" describe block below,
 * which exercises that real, UNstubbed path deliberately). The tests in
 * this file that simulate "the job was enqueued and the worker already
 * ran it" need the OPPOSITE signal: a successful enqueue, so
 * `createCampaignOrSplit` returns `split_pending` the same way it would
 * against a real, healthy queue, so the test can then call
 * `runSplitAnalysis` directly to simulate the worker (the db lane has no
 * live worker to consume the job either way — mirrors
 * `hash-list-split.db.test.ts`'s convention).
 */
async function withFakeSuccessfulEnqueue<T>(fn: () => Promise<T>): Promise<T> {
  const fakeQueueManager = { enqueue: async () => true }
  const originalGetQueueContext = _campaignSplitDeps.getQueueContext
  _campaignSplitDeps.getQueueContext = (() =>
    Promise.resolve({
      getQueueManager: () => fakeQueueManager,
    })) as typeof _campaignSplitDeps.getQueueContext
  try {
    return await fn()
  } finally {
    _campaignSplitDeps.getQueueContext = originalGetQueueContext
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createCampaignOrSplit + confirmSplitCampaign — mixed list full flow', () => {
  it('enqueues (split_pending), the worker splits, status transitions to ready, resolves the ambiguous group, and creates a parent + one sub-campaign per resolved sub-list', async () => {
    const parentId = await createHashList('split-confirm-mixed-parent', mixedTypeAnalysis())
    const confidentValues = [sha512Crypt('salt0001'), sha512Crypt('salt0002')]
    const ambiguousValues = [HEX32, 'd'.repeat(32)]
    const unidentifiedValues = [garbage(0)]
    await insertHashValues(parentId, [
      ...confidentValues,
      ...ambiguousValues,
      ...unidentifiedValues,
    ])

    // First call against a never-split mixed parent: no `runSplitAnalysis`
    // run inline (SU7) — just the pending signal. No children yet. The db
    // lane has no live Redis, so a real enqueue would fail (code review
    // fix — see the dedicated "enqueue failure" describe block); stub a
    // successful enqueue here to simulate a healthy queue and reach the
    // `split_pending` state this test wants to exercise.
    const createResult = await withFakeSuccessfulEnqueue(() =>
      createCampaignOrSplit({
        projectId: projId,
        name: 'mixed-campaign',
        hashListId: parentId,
        attacks: [],
      })
    )
    expect(createResult.kind).toBe('split_pending')
    if (createResult.kind !== 'split_pending') throw new Error('expected split_pending')
    expect(createResult.hashListId).toBe(parentId)
    expect(await childrenOf(parentId)).toHaveLength(0)

    // The db test lane has no live Redis to run the real worker — simulate
    // it by calling the same core the job processor calls.
    const splitResult = await runSplitAnalysis(parentId)
    expect(splitResult.outcome).toBe('split')

    // Status poll now reads `ready` off the children that exist (not off
    // job state — the db lane has no queue manager, so job lookup returns
    // null and the children-exist branch is what carries the signal).
    const statusResult = await getSplitStatus(parentId, projId)
    expect(statusResult.kind).toBe('ok')
    if (statusResult.kind !== 'ok') throw new Error('expected ok')
    expect(statusResult.response.status).toBe('ready')
    const reviewGroups = statusResult.response.reviewGroups
    expect(reviewGroups).not.toBeNull()
    if (!reviewGroups) throw new Error('expected reviewGroups')
    expect(reviewGroups.confident).toHaveLength(1)
    expect(reviewGroups.confident[0]?.mode).toBe(SHA512_CRYPT_MODE)
    expect(reviewGroups.ambiguous).toHaveLength(1)
    expect(reviewGroups.ambiguous[0]?.candidateModes).toEqual(HEX32_SIGNATURE)
    expect(reviewGroups.unidentified).toHaveLength(1)

    // A second createCampaignOrSplit call now finds the children the
    // worker created and returns the review groups directly, same as the
    // status poll's `ready` branch — the already-split path.
    const secondCreateResult = await createCampaignOrSplit({
      projectId: projId,
      name: 'mixed-campaign',
      hashListId: parentId,
      attacks: [],
    })
    expect(secondCreateResult.kind).toBe('split_review')
    if (secondCreateResult.kind !== 'split_review') throw new Error('expected split_review')
    expect(secondCreateResult.confident).toHaveLength(1)
    expect(secondCreateResult.ambiguous).toHaveLength(1)
    expect(secondCreateResult.unidentified).toHaveLength(1)

    const ambiguousSubListId = reviewGroups.ambiguous[0]!.id

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
    const unidentifiedSubListId = reviewGroups.unidentified[0]!.id
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

describe('confirmSplitCampaign — sub-campaign name truncation (bug fix Major)', () => {
  it('truncates a 255-char base name so the sub-campaign name never exceeds campaigns.name (varchar(255))', async () => {
    const parentId = await createHashList('split-confirm-trunc-parent')

    const childId = await createHashList(
      'split-confirm-trunc-child',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [{ hashcatMode: NTLM_MODE, count: 1 }],
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(childId, ['trunc-confirm-1'])

    // Base name already at the campaigns.name cap — appending " - mode <n>"
    // unconditionally would push the sub-campaign name past varchar(255) and
    // fail with a Postgres 22001 error.
    const maxLengthName = 'y'.repeat(255)

    const confirmResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: maxLengthName,
      assignments: [{ subListId: childId, mode: NTLM_MODE }],
    })

    expect(confirmResult.kind).toBe('confirmed')
    if (confirmResult.kind !== 'confirmed') throw new Error('expected confirmed')
    expect(confirmResult.subCampaigns).toHaveLength(1)

    const [subCampaignRow] = await campaignsOn(childId)
    expect(subCampaignRow).toBeDefined()
    expect(subCampaignRow!.name.length).toBeLessThanOrEqual(255)
    // ASCII hyphen, never an em dash (bug fix — punctuation).
    expect(subCampaignRow!.name).toContain(` - mode ${NTLM_MODE}`)
    expect(subCampaignRow!.name).not.toContain('—')
  })
})

describe('createCampaignOrSplit — already-split parent (children exist)', () => {
  it('returns split_review directly, with no enqueue, when the parent already has children', async () => {
    const parentId = await createHashList('split-confirm-already-split-parent', mixedTypeAnalysis())
    const childId = await createHashList(
      'split-confirm-already-split-child',
      mixedTypeAnalysis({
        verdict: 'homogeneous',
        detectedModes: [{ hashcatMode: 1800, count: 1 }],
      }),
      parentId
    )
    await insertHashValues(childId, [sha512Crypt('already-split-1')])

    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'already-split-campaign',
      hashListId: parentId,
      attacks: [],
    })

    expect(result.kind).toBe('split_review')
    if (result.kind !== 'split_review') throw new Error('expected split_review')
    expect(result.parentHashListId).toBe(parentId)
    expect(result.confident).toHaveLength(1)
    expect(result.confident[0]?.id).toBe(childId)
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

  it('single_group: status surfaces the degenerate outcome, and the skipSplit resubmit falls back to a plain campaign with no scaffolding', async () => {
    const listId = await createHashList('split-confirm-degenerate-single', mixedTypeAnalysis())
    // All items classify to the SAME confident group despite the
    // ingestion-time "mixed" verdict — planSplit collapses to one group.
    await insertHashValues(listId, [sha512Crypt('deg00001'), sha512Crypt('deg00002')])

    // The db lane has no live Redis, so stub a successful enqueue (see
    // `withFakeSuccessfulEnqueue`'s doc comment) to reach `split_pending`.
    const pendingResult = await withFakeSuccessfulEnqueue(() =>
      createCampaignOrSplit({
        projectId: projId,
        name: 'degenerate-single-campaign',
        hashListId: listId,
        attacks: [],
      })
    )
    expect(pendingResult.kind).toBe('split_pending')

    // Simulate the worker running the job: the classifier collapses to one
    // group, so no children are created (items stay on the original list).
    const splitResult = await runSplitAnalysis(listId)
    expect(splitResult.outcome).toBe('degenerate-single-group')
    expect(await childrenOf(listId)).toHaveLength(0)

    // The db lane has no queue manager, so `jobInfo` is null — the status
    // lookup can't observe the degenerate outcome off the (nonexistent) job
    // state. It reads `single_group` anyway (code review fix): the
    // degenerate outcome is a durable marker
    // (`hash_lists.statistics.splitOutcome`) `runSplitAnalysis` persists on
    // the parent row in the same transaction that decides the outcome, so
    // `getSplitStatus` recovers it even with zero queue signal available —
    // proving the fix without needing to simulate job eviction. What
    // matters for this test is the client-facing recovery path: the
    // wizard's `single_group` handler re-submits with `skipSplit: true`
    // regardless of how it learned the outcome, and that resubmit must fall
    // back to a plain campaign with no scaffolding.
    const statusResult = await getSplitStatus(listId, projId)
    expect(statusResult.kind).toBe('ok')
    if (statusResult.kind !== 'ok') throw new Error('expected ok')
    expect(statusResult.response.status).toBe('single_group')

    const skipSplitResult = await createCampaignOrSplit({
      projectId: projId,
      name: 'degenerate-single-campaign',
      hashListId: listId,
      attacks: [],
      skipSplit: true,
    })

    expect(skipSplitResult.kind).toBe('created')
    const children = await childrenOf(listId)
    expect(children).toHaveLength(0)
    const items = await db.select().from(hashItems).where(eq(hashItems.hashListId, listId))
    expect(items).toHaveLength(2)
  })

  it('degenerate-empty: enqueues (split_pending) and creates no campaign or children once the worker runs', async () => {
    const listId = await createHashList('split-confirm-degenerate-empty', mixedTypeAnalysis())

    // The db lane has no live Redis, so stub a successful enqueue (see
    // `withFakeSuccessfulEnqueue`'s doc comment) to reach `split_pending`.
    const pendingResult = await withFakeSuccessfulEnqueue(() =>
      createCampaignOrSplit({
        projectId: projId,
        name: 'degenerate-empty-campaign',
        hashListId: listId,
        attacks: [],
      })
    )
    expect(pendingResult.kind).toBe('split_pending')

    const splitResult = await runSplitAnalysis(listId)
    expect(splitResult.outcome).toBe('degenerate-empty')

    const rows = await campaignsOn(listId)
    expect(rows).toHaveLength(0)
    const children = await childrenOf(listId)
    expect(children).toHaveLength(0)

    // Code review fix: `degenerate-empty` leaves no children row and the db
    // lane has no queue manager (jobInfo is always null here) — the ONLY
    // signal `getSplitStatus` has left is the durable
    // `statistics.splitOutcome` marker `runSplitAnalysis` persists on the
    // parent. An `empty` parent's `statistics` is the DB column default
    // `{}` (no items were ever parsed), which is exactly the shape that
    // would defeat a naive full-schema-validated read — see
    // `extractPersistedSplitOutcome`'s doc comment for why this case is
    // singled out.
    const statusResult = await getSplitStatus(listId, projId)
    expect(statusResult.kind).toBe('ok')
    if (statusResult.kind !== 'ok') throw new Error('expected ok')
    expect(statusResult.response.status).toBe('empty')
    expect(statusResult.response.message).not.toBeNull()
  })
})

describe('createCampaignOrSplit — skipSplit is server-verified (security fix, CodeRabbit)', () => {
  it('rejects skipSplit when the list has NOT been split but still classifies into 2+ groups', async () => {
    const listId = await createHashList('split-confirm-skipsplit-still-mixed', mixedTypeAnalysis())
    // One confident (SHA-512 Crypt) item and one ambiguous (32-hex) item —
    // `planSplit` genuinely finds 2 groups here, unlike the degenerate
    // single-group fixture above. `skipSplit` must NOT be able to bypass
    // this: honoring it would create a single-mode campaign on a list that
    // actually needs two different hashcat modes to crack.
    await insertHashValues(listId, [sha512Crypt('skipsplit-still-mixed-1'), HEX32])

    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'skipsplit-still-mixed-campaign',
      hashListId: listId,
      attacks: [],
      skipSplit: true,
    })

    expect(result.kind).toBe('skip_split_rejected')
    if (result.kind !== 'skip_split_rejected') throw new Error('expected skip_split_rejected')
    expect(result.hashListId).toBe(listId)

    // No campaign, no children — the request was refused, not silently
    // downgraded to a wrong-mode create.
    expect(await childrenOf(listId)).toHaveLength(0)
    expect(await campaignsOn(listId)).toHaveLength(0)
  })

  it('rejects skipSplit when the list has already been split into real (2+) children', async () => {
    const parentId = await createHashList(
      'split-confirm-skipsplit-already-split-parent',
      mixedTypeAnalysis()
    )
    const confidentChildId = await createHashList(
      'split-confirm-skipsplit-already-split-child-confident',
      mixedTypeAnalysis({
        verdict: 'homogeneous',
        detectedModes: [{ hashcatMode: SHA512_CRYPT_MODE, count: 1 }],
      }),
      parentId
    )
    const ambiguousChildId = await createHashList(
      'split-confirm-skipsplit-already-split-child-ambiguous',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: HEX32_SIGNATURE.map((hashcatMode) => ({ hashcatMode, count: 1 })),
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(confidentChildId, [sha512Crypt('skipsplit-already-split-1')])
    await insertHashValues(ambiguousChildId, [HEX32])

    // A malicious (or buggy) client sets skipSplit on a parent that a prior
    // call already split into real, still-unresolved children — this must
    // never bypass the review flow, regardless of how many groups exist.
    const result = await createCampaignOrSplit({
      projectId: projId,
      name: 'skipsplit-already-split-campaign',
      hashListId: parentId,
      attacks: [],
      skipSplit: true,
    })

    expect(result.kind).toBe('skip_split_rejected')
    if (result.kind !== 'skip_split_rejected') throw new Error('expected skip_split_rejected')
    expect(result.hashListId).toBe(parentId)

    // Neither child was touched, and no campaign was created on the parent.
    expect(await childrenOf(parentId)).toHaveLength(2)
    expect(await campaignsOn(parentId)).toHaveLength(0)
  })
})

describe('getSplitStatus — degenerate outcomes read through a stubbed QueueManager', () => {
  it('completed degenerate-empty job -> status "empty" with a message', async () => {
    const listId = await createHashList('split-status-empty-job', mixedTypeAnalysis())

    // The db test lane has no live Redis (see the file-level doc comment),
    // so this stubs `_campaignSplitDeps.getQueueContext` — the same seam
    // `enqueueSplitJob`/`getSplitJobInfo` use — to prove `getSplitStatus`
    // actually reads a job's `returnvalue` through `QueueManager.getJobInfo`
    // for the outcomes that leave no `hash_lists` children row to read
    // instead (advisor-flagged gap: the pure `deriveSplitStatus` unit tests
    // alone don't exercise this wiring).
    const fakeQueueManager = {
      getJobInfo: async () => ({
        state: 'completed',
        returnvalue: { outcome: 'degenerate-empty' },
        failedReason: null,
      }),
    }
    const originalGetQueueContext = _campaignSplitDeps.getQueueContext
    _campaignSplitDeps.getQueueContext = (() =>
      Promise.resolve({
        getQueueManager: () => fakeQueueManager,
      })) as typeof _campaignSplitDeps.getQueueContext

    try {
      const result = await getSplitStatus(listId, projId)
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('expected ok')
      expect(result.response.status).toBe('empty')
      expect(result.response.reviewGroups).toBeNull()
      expect(result.response.message).not.toBeNull()
    } finally {
      _campaignSplitDeps.getQueueContext = originalGetQueueContext
    }
  })
})

describe('getSplitStatus — child lookup is project-scoped (code review fix, defense-in-depth)', () => {
  it('never reads a same-parent-id row from a DIFFERENT project as a "child", even if it slipped past the migration-0040 trigger', async () => {
    const parentId = await createHashList('split-status-scope-parent', mixedTypeAnalysis())
    const otherSlug = 'split-status-scope-other-proj'
    await db.delete(projects).where(eq(projects.slug, otherSlug))
    const [otherProject] = await db
      .insert(projects)
      .values({ name: otherSlug, slug: otherSlug })
      .returning({ id: projects.id })
    const otherProjectId = otherProject!.id

    try {
      // The DB trigger (migration 0040) enforces that a `parent_hash_list_id`
      // child shares its parent's `project_id` — that's exactly what this
      // test needs to bypass to exercise the code-level filter at all.
      // `SET LOCAL` is transaction-scoped: it reverts automatically at
      // commit and never leaks to another connection/test, so this can't
      // make the DB lane flaky for anything else running concurrently.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`)
        await tx.insert(hashLists).values({
          projectId: otherProjectId,
          parentHashListId: parentId,
          name: 'cross-tenant-child',
          status: 'ready',
        })
      })

      // Without the FIX 2 filter, `getSplitStatus`'s children lookup would
      // find this row by `parentHashListId` alone and read `ready` — the
      // explicit `eq(hashLists.projectId, projectId)` must exclude it, so
      // the parent (which has ZERO real children) still reads `pending`.
      const result = await getSplitStatus(parentId, projId)
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('expected ok')
      expect(result.response.status).not.toBe('ready')
      expect(result.response.status).toBe('pending')
    } finally {
      await db.delete(projects).where(eq(projects.id, otherProjectId))
    }
  })
})

describe('createCampaignOrSplit — enqueue failure (code review fix)', () => {
  it('returns split_enqueue_failed, never split_pending, when the queue enqueue call itself fails', async () => {
    const listId = await createHashList('split-enqueue-failure', mixedTypeAnalysis())
    await insertHashValues(listId, [sha512Crypt('enqueue-fail-1')])

    // The db test lane has no live Redis, so this stubs
    // `_campaignSplitDeps.getQueueContext` — the same seam
    // `enqueueSplitJob` uses — with a QueueManager whose `enqueue` resolves
    // `false` (mirrors what the real QueueManager returns when `queue.add`
    // throws or the queue isn't registered; see `queue/manager.ts`).
    // Previously this failure was discarded and `createCampaignOrSplit`
    // still returned `split_pending`, leaving the wizard polling forever
    // against a job that was never created.
    const fakeQueueManager = { enqueue: async () => false }
    const originalGetQueueContext = _campaignSplitDeps.getQueueContext
    _campaignSplitDeps.getQueueContext = (() =>
      Promise.resolve({
        getQueueManager: () => fakeQueueManager,
      })) as typeof _campaignSplitDeps.getQueueContext

    try {
      const result = await createCampaignOrSplit({
        projectId: projId,
        name: 'enqueue-failure-campaign',
        hashListId: listId,
        attacks: [],
      })
      expect(result.kind).toBe('split_enqueue_failed')
      if (result.kind !== 'split_enqueue_failed') throw new Error('expected split_enqueue_failed')
      expect(result.hashListId).toBe(listId)

      // No job, no children, no campaign — nothing was created.
      expect(await childrenOf(listId)).toHaveLength(0)
      expect(await campaignsOn(listId)).toHaveLength(0)
    } finally {
      _campaignSplitDeps.getQueueContext = originalGetQueueContext
    }
  })
})

describe('confirmSplitCampaign — self-healing retries (code review fix)', () => {
  const BACKFILL_MODE_A = 9_999_401
  const BACKFILL_MODE_B = 9_999_402
  const RETRY_MODE_A = 9_999_501
  const RETRY_MODE_B = 9_999_502

  async function makeAmbiguousParentWithTwoChildren(
    slug: string,
    modeA: number,
    modeB: number
  ): Promise<{ parentId: number; childAId: number; childBId: number }> {
    const parentId = await createHashList(slug)
    const childAId = await createHashList(
      `${slug}-child-a`,
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: modeA, count: 2 },
          { hashcatMode: modeA + 1, count: 2 },
        ],
        scannedCount: 2,
      }),
      parentId
    )
    const childBId = await createHashList(
      `${slug}-child-b`,
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: modeB, count: 3 },
          { hashcatMode: modeB + 1, count: 3 },
        ],
        scannedCount: 3,
      }),
      parentId
    )
    await insertHashValues(childAId, [`${slug}-a-1`, `${slug}-a-2`])
    await insertHashValues(childBId, [`${slug}-b-1`, `${slug}-b-2`, `${slug}-b-3`])
    return { parentId, childAId, childBId }
  }

  it('partial confirm (parent + 1 of 2 sub-campaigns) self-heals on retry: backfills the missing sub-campaign without duplicating the surviving one', async () => {
    const { parentId, childAId, childBId } = await makeAmbiguousParentWithTwoChildren(
      'split-confirm-backfill',
      BACKFILL_MODE_A,
      BACKFILL_MODE_B
    )

    const firstResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'backfill-campaign',
      assignments: [
        { subListId: childAId, mode: BACKFILL_MODE_A },
        { subListId: childBId, mode: BACKFILL_MODE_B },
      ],
    })
    expect(firstResult.kind).toBe('confirmed')
    if (firstResult.kind !== 'confirmed') throw new Error('expected confirmed')
    expect(firstResult.subCampaigns).toHaveLength(2)

    // Simulate the documented crash window: a prior run got as far as
    // creating the parent campaign and ONE of the two sub-campaigns before
    // dying. Deleting one of the just-created sub-campaign rows reproduces
    // that exact DB state (parent exists, children already resolved,
    // partial sub-campaign set) without needing to literally interrupt
    // `confirmSplitCampaign` mid-execution.
    const survivingSub = firstResult.subCampaigns.find((s) => s.hashListId === childAId)!
    const missingSub = firstResult.subCampaigns.find((s) => s.hashListId === childBId)!
    await db.delete(campaigns).where(eq(campaigns.id, missingSub.id))
    expect(await campaignsOn(childBId)).toHaveLength(0)

    // Retry with the SAME assignments the first call used.
    const retryResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'backfill-campaign',
      assignments: [
        { subListId: childAId, mode: BACKFILL_MODE_A },
        { subListId: childBId, mode: BACKFILL_MODE_B },
      ],
    })
    expect(retryResult.kind).toBe('confirmed')
    if (retryResult.kind !== 'confirmed') throw new Error('expected confirmed')

    // Same parent campaign — never re-created.
    expect(retryResult.parentCampaign.id).toBe(firstResult.parentCampaign.id)

    // The complete set is now present: the surviving sub-campaign is
    // returned UNCHANGED (same id, not recreated); the missing one is
    // backfilled with a fresh row targeting the same sub-list + mode.
    expect(retryResult.subCampaigns).toHaveLength(2)
    const retrySurviving = retryResult.subCampaigns.find((s) => s.hashListId === childAId)
    const retryBackfilled = retryResult.subCampaigns.find((s) => s.hashListId === childBId)
    expect(retrySurviving?.id).toBe(survivingSub.id)
    expect(retryBackfilled?.id).not.toBe(missingSub.id)
    expect(retryBackfilled?.mode).toBe(BACKFILL_MODE_B)

    // DB-level: exactly one campaign row per sub-list under this parent —
    // no duplicate for the surviving one, exactly one backfilled row for
    // the missing one.
    const allSubs = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.parentCampaignId, retryResult.parentCampaign.id))
    expect(allSubs).toHaveLength(2)
    expect(await campaignsOn(childAId)).toHaveLength(1)
    expect(await campaignsOn(childBId)).toHaveLength(1)
  })

  it('a fully-confirmed ambiguous split re-run returns the same set with no duplicates and no invalid_assignment 409 (permanent-409 regression)', async () => {
    const { parentId, childAId, childBId } = await makeAmbiguousParentWithTwoChildren(
      'split-confirm-full-retry',
      RETRY_MODE_A,
      RETRY_MODE_B
    )

    const assignments = [
      { subListId: childAId, mode: RETRY_MODE_A },
      { subListId: childBId, mode: RETRY_MODE_B },
    ]

    const firstResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'full-retry-campaign',
      assignments,
    })
    expect(firstResult.kind).toBe('confirmed')
    if (firstResult.kind !== 'confirmed') throw new Error('expected confirmed')
    expect(firstResult.subCampaigns).toHaveLength(2)

    // Re-run with the IDENTICAL assignments — a client retry after a
    // timeout on an already-successful response. Before the fix, this
    // would hit `invalid_assignment` on every retry (the children are no
    // longer 'needs-review') with no way to ever get a `confirmed`
    // response back.
    const retryResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'full-retry-campaign',
      assignments,
    })
    expect(retryResult.kind).toBe('confirmed')
    if (retryResult.kind !== 'confirmed') throw new Error('expected confirmed')

    expect(retryResult.parentCampaign.id).toBe(firstResult.parentCampaign.id)
    const firstIds = firstResult.subCampaigns.map((s) => s.id).sort((a, b) => a - b)
    const retryIds = retryResult.subCampaigns.map((s) => s.id).sort((a, b) => a - b)
    expect(retryIds).toEqual(firstIds)

    // DB-level: still exactly 2 sub-campaigns under this parent — the
    // retry created nothing new.
    const allSubs = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.parentCampaignId, retryResult.parentCampaign.id))
    expect(allSubs).toHaveLength(2)
  })
})

describe('confirmSplitCampaign — invalid-assignment validation (code review fix)', () => {
  const IDEMPOTENT_MODE = 9_999_601
  const IDEMPOTENT_OTHER_MODE = 9_999_602
  const NONEXISTENT_MODE = 9_999_801
  const CONFLICT_ORIGINAL_MODE = 9_999_701
  const CONFLICT_REQUESTED_MODE = 9_999_702

  it('a same-mode retry against an already-resolved sub-list is an idempotent no-op, not invalid_assignment', async () => {
    const parentId = await createHashList('split-confirm-idempotent-retry-parent')
    const childId = await createHashList(
      'split-confirm-idempotent-retry-child',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: IDEMPOTENT_MODE, count: 1 },
          { hashcatMode: IDEMPOTENT_OTHER_MODE, count: 1 },
        ],
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(childId, ['idempotent-retry-1'])

    const firstResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'idempotent-retry-campaign',
      assignments: [{ subListId: childId, mode: IDEMPOTENT_MODE }],
    })
    expect(firstResult.kind).toBe('confirmed')
    if (firstResult.kind !== 'confirmed') throw new Error('expected confirmed')
    expect(firstResult.subCampaigns).toHaveLength(1)

    // Retry with the EXACT same assignment — the child is now homogeneous
    // at IDEMPOTENT_MODE, which matches what this assignment requests, so
    // this must be treated as an idempotent no-op.
    const retryResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'idempotent-retry-campaign',
      assignments: [{ subListId: childId, mode: IDEMPOTENT_MODE }],
    })
    expect(retryResult.kind).toBe('confirmed')
    if (retryResult.kind !== 'confirmed') throw new Error('expected confirmed')
    expect(retryResult.parentCampaign.id).toBe(firstResult.parentCampaign.id)
    expect(retryResult.subCampaigns).toHaveLength(1)
    expect(retryResult.subCampaigns[0]?.id).toBe(firstResult.subCampaigns[0]?.id)

    // DB-level: no duplicate sub-campaign was created.
    expect(await campaignsOn(childId)).toHaveLength(1)
  })

  it('rejects an assignment referencing a subListId that is not a child of the parent', async () => {
    const parentId = await createHashList('split-confirm-nonexistent-parent')
    const childId = await createHashList(
      'split-confirm-nonexistent-child',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: NONEXISTENT_MODE, count: 1 },
          { hashcatMode: NONEXISTENT_MODE + 1, count: 1 },
        ],
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(childId, ['nonexistent-1'])

    // A real hash-list row, but NOT a child of this parent — mirrors a
    // stale/tampered subListId rather than a plain typo.
    const unrelatedListId = await createHashList('split-confirm-nonexistent-unrelated')

    const result = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'nonexistent-campaign',
      assignments: [{ subListId: unrelatedListId, mode: NONEXISTENT_MODE }],
    })

    expect(result.kind).toBe('invalid_assignment')
    if (result.kind !== 'invalid_assignment') throw new Error('expected invalid_assignment')
    expect(result.reason).toContain(String(unrelatedListId))

    // Nothing was created or mutated — the genuinely ambiguous child is
    // untouched, and no campaign exists for this parent.
    expect(await campaignsOn(parentId)).toHaveLength(0)
    const [child] = await db.select().from(hashLists).where(eq(hashLists.id, childId))
    expect(child!.typeAnalysis?.verdict).toBe('needs-review')
  })

  it('rejects a conflicting-mode reassignment against an already-resolved sub-list', async () => {
    const parentId = await createHashList('split-confirm-conflict-parent')
    const childId = await createHashList(
      'split-confirm-conflict-child',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: CONFLICT_ORIGINAL_MODE, count: 1 },
          { hashcatMode: CONFLICT_REQUESTED_MODE, count: 1 },
        ],
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(childId, ['conflict-1'])

    const firstResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'conflict-campaign',
      assignments: [{ subListId: childId, mode: CONFLICT_ORIGINAL_MODE }],
    })
    expect(firstResult.kind).toBe('confirmed')

    // Re-run with a DIFFERENT mode against the same now-resolved sub-list —
    // a conflicting reassignment attempt must be rejected, not silently
    // ignored as if it were a matching retry.
    const conflictResult = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'conflict-campaign',
      assignments: [{ subListId: childId, mode: CONFLICT_REQUESTED_MODE }],
    })
    expect(conflictResult.kind).toBe('invalid_assignment')
    if (conflictResult.kind !== 'invalid_assignment') {
      throw new Error('expected invalid_assignment')
    }
    expect(conflictResult.reason).toContain(String(CONFLICT_ORIGINAL_MODE))
    expect(conflictResult.reason).toContain(String(CONFLICT_REQUESTED_MODE))

    // DB-level: still resolved to the ORIGINAL mode — the conflicting
    // request did not silently change it, and no second sub-campaign exists.
    const [child] = await db.select().from(hashLists).where(eq(hashLists.id, childId))
    expect(child!.typeAnalysis?.detectedModes[0]?.hashcatMode).toBe(CONFLICT_ORIGINAL_MODE)
    expect(await campaignsOn(childId)).toHaveLength(1)
  })
})

describe('sole ambiguous/unidentified group is NOT degenerate single-group (bug fix — CodeRabbit, Major correctness)', () => {
  it('a list that is entirely AMBIGUOUS (all 32-hex) rejects skipSplit and goes through the real split/review path, never a plain campaign', async () => {
    const listId = await createHashList('split-confirm-sole-ambiguous', mixedTypeAnalysis())
    // Every item is a 32-hex string — all classify to the SAME ambiguous
    // signature, so `planSplit` collapses to exactly one group. That group
    // is NOT confidently resolved, so it must never be treated the same as
    // the genuine single-confident-group fallback above.
    const ambiguousValues = [HEX32, 'd'.repeat(32)]
    await insertHashValues(listId, ambiguousValues)

    // skipSplit must be rejected: `verifiesSingleGroup` now checks the sole
    // group's kind, not just its count.
    const skipSplitResult = await createCampaignOrSplit({
      projectId: projId,
      name: 'sole-ambiguous-campaign',
      hashListId: listId,
      attacks: [],
      skipSplit: true,
    })
    expect(skipSplitResult.kind).toBe('skip_split_rejected')
    expect(await campaignsOn(listId)).toHaveLength(0)
    expect(await childrenOf(listId)).toHaveLength(0)

    // The normal (non-skipSplit) path enqueues the split job — no plain
    // campaign is silently created for an unresolved ambiguous list.
    const pendingResult = await withFakeSuccessfulEnqueue(() =>
      createCampaignOrSplit({
        projectId: projId,
        name: 'sole-ambiguous-campaign',
        hashListId: listId,
        attacks: [],
      })
    )
    expect(pendingResult.kind).toBe('split_pending')

    // The worker must NOT collapse this to `degenerate-single-group` — it
    // creates a real (one-child) split so the ambiguous group is presented
    // for review/assignment instead of vanishing into a wrong-mode campaign.
    const splitResult = await runSplitAnalysis(listId)
    expect(splitResult.outcome).toBe('split')
    expect(splitResult.subLists).toHaveLength(1)
    expect(splitResult.subLists[0]?.kind).toBe('ambiguous')
    expect(splitResult.subLists[0]?.itemCount).toBe(ambiguousValues.length)

    const children = await childrenOf(listId)
    expect(children).toHaveLength(1)
    expect(children[0]?.typeAnalysis?.verdict).toBe('needs-review')
    expect(children[0]?.typeAnalysis?.detectedModes.map((d) => d.hashcatMode)).toEqual(
      HEX32_SIGNATURE
    )

    // Still no plain campaign was created on the original (now-shell) list.
    expect(await campaignsOn(listId)).toHaveLength(0)
  })

  it('a list that is entirely UNIDENTIFIED rejects skipSplit and goes through the real split/review path, never a plain campaign', async () => {
    const listId = await createHashList('split-confirm-sole-unidentified', mixedTypeAnalysis())
    const unidentifiedValues = [garbage(100), garbage(101)]
    await insertHashValues(listId, unidentifiedValues)

    const skipSplitResult = await createCampaignOrSplit({
      projectId: projId,
      name: 'sole-unidentified-campaign',
      hashListId: listId,
      attacks: [],
      skipSplit: true,
    })
    expect(skipSplitResult.kind).toBe('skip_split_rejected')
    expect(await campaignsOn(listId)).toHaveLength(0)
    expect(await childrenOf(listId)).toHaveLength(0)

    const pendingResult = await withFakeSuccessfulEnqueue(() =>
      createCampaignOrSplit({
        projectId: projId,
        name: 'sole-unidentified-campaign',
        hashListId: listId,
        attacks: [],
      })
    )
    expect(pendingResult.kind).toBe('split_pending')

    const splitResult = await runSplitAnalysis(listId)
    expect(splitResult.outcome).toBe('split')
    expect(splitResult.subLists).toHaveLength(1)
    expect(splitResult.subLists[0]?.kind).toBe('unidentified')
    expect(splitResult.subLists[0]?.itemCount).toBe(unidentifiedValues.length)

    const children = await childrenOf(listId)
    expect(children).toHaveLength(1)
    expect(children[0]?.typeAnalysis?.verdict).toBe('needs-review')
    expect(children[0]?.typeAnalysis?.unidentifiedCount).toBe(unidentifiedValues.length)

    expect(await campaignsOn(listId)).toHaveLength(0)
  })
})

describe('confirmSplitCampaign — rejects an unassigned ambiguous child (bug fix — CodeRabbit, Major correctness)', () => {
  const UNASSIGNED_MODE_A = 9_999_901
  const UNASSIGNED_MODE_B = 9_999_902
  const ASSIGNED_ONLY_MODE = 9_999_903
  const ASSIGNED_ONLY_OTHER_MODE = 9_999_904
  const NOOP_AMBIGUOUS_MODE = 9_999_905
  const NOOP_AMBIGUOUS_OTHER_MODE = 9_999_906

  it('rejects confirmation when one ambiguous child has no assignment, and mutates neither child', async () => {
    const parentId = await createHashList('split-confirm-unresolved-ambiguous-parent')
    const assignedChildId = await createHashList(
      'split-confirm-unresolved-ambiguous-child-assigned',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: ASSIGNED_ONLY_MODE, count: 1 },
          { hashcatMode: ASSIGNED_ONLY_OTHER_MODE, count: 1 },
        ],
        scannedCount: 1,
      }),
      parentId
    )
    const unassignedChildId = await createHashList(
      'split-confirm-unresolved-ambiguous-child-unassigned',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: UNASSIGNED_MODE_A, count: 1 },
          { hashcatMode: UNASSIGNED_MODE_B, count: 1 },
        ],
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(assignedChildId, ['unresolved-ambiguous-assigned-1'])
    await insertHashValues(unassignedChildId, ['unresolved-ambiguous-unassigned-1'])

    const result = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'unresolved-ambiguous-campaign',
      // Only assigns the first child — the second is left ambiguous.
      assignments: [{ subListId: assignedChildId, mode: ASSIGNED_ONLY_MODE }],
    })

    expect(result.kind).toBe('invalid_assignment')
    if (result.kind !== 'invalid_assignment') throw new Error('expected invalid_assignment')
    expect(result.reason).toContain(String(unassignedChildId))

    // Nothing was created or mutated — including the child that WAS given a
    // valid assignment; validation runs entirely before any mutation, so a
    // rejected confirm can never partially apply.
    expect(await campaignsOn(parentId)).toHaveLength(0)
    const [assignedChild] = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, assignedChildId))
    expect(assignedChild!.typeAnalysis?.verdict).toBe('needs-review')
    const [unassignedChild] = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, unassignedChildId))
    expect(unassignedChild!.typeAnalysis?.verdict).toBe('needs-review')
  })

  it('does NOT reject when the unassigned sibling is UNIDENTIFIED (needs-type), not ambiguous — that legitimately has no sub-campaign', async () => {
    const parentId = await createHashList('split-confirm-unidentified-noop-parent')
    const ambiguousChildId = await createHashList(
      'split-confirm-unidentified-noop-child-ambiguous',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [
          { hashcatMode: NOOP_AMBIGUOUS_MODE, count: 1 },
          { hashcatMode: NOOP_AMBIGUOUS_OTHER_MODE, count: 1 },
        ],
        scannedCount: 1,
      }),
      parentId
    )
    const unidentifiedChildId = await createHashList(
      'split-confirm-unidentified-noop-child-unidentified',
      mixedTypeAnalysis({
        verdict: 'needs-review',
        detectedModes: [],
        unidentifiedCount: 1,
        scannedCount: 1,
      }),
      parentId
    )
    await insertHashValues(ambiguousChildId, ['unidentified-noop-ambiguous-1'])
    await insertHashValues(unidentifiedChildId, ['unidentified-noop-unidentified-1'])

    const result = await confirmSplitCampaign({
      projectId: projId,
      parentHashListId: parentId,
      name: 'unidentified-noop-campaign',
      assignments: [{ subListId: ambiguousChildId, mode: NOOP_AMBIGUOUS_MODE }],
    })

    expect(result.kind).toBe('confirmed')
    if (result.kind !== 'confirmed') throw new Error('expected confirmed')
    expect(result.subCampaigns).toHaveLength(1)
    expect(result.subCampaigns[0]?.hashListId).toBe(ambiguousChildId)

    // The unidentified sibling legitimately has no sub-campaign — it was
    // never assigned a mode and never could be.
    expect(await campaignsOn(unidentifiedChildId)).toHaveLength(0)
  })
})
