/**
 * Real-DB tests for U5: the zaps endpoint composite cursor
 * (docs/plans/2026-07-12-001-feat-zaps-composite-cursor-plan.md).
 *
 * These prove the property the whole change exists for, against a real
 * Postgres — SQL comparison semantics over tied `crackedAt` timestamps
 * cannot be proven with mocks:
 *
 * 1. Exactly-once walk: an agent that starts with no cursor and repeatedly
 *    calls back with the returned `nextCursor` reads every cracked hash
 *    value exactly once, terminating when `nextCursor` is null — even when
 *    MORE than `limit` rows share ONE `crackedAt` timestamp (the case the
 *    old single-timestamp `since` cursor skipped or replayed).
 * 2. Tied cluster straddling a page boundary loses/repeats nothing.
 * 3. Exhaustion returns `nextCursor: null`.
 * 4. Empty / no-cracked-rows hash list → `{ zaps: [], nextCursor: null }`.
 * 5. Immutability characterization (KTD4): moving a row's `crackedAt`
 *    FORWARD (the monotonic re-crack mutation) can cause a benign REPLAY
 *    but never a SKIP — every cracked hash remains reachable.
 *
 * Timestamps are seeded MILLISECOND-ALIGNED (`new Date(fixedMillis)`),
 * matching how every write path in the app actually writes `crackedAt`
 * (KTD3's ms-aligned-writes invariant). Do NOT rebuild these on sub-ms
 * values — that is not a state the write paths can produce.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the
 * shared drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */
import { agents, attacks, campaigns, hashItems, hashLists, projects, tasks } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { decodeZapCursor, type ZapCursor } from '../../src/services/tasks/zap-cursor.js'
import { getZapsForTask } from '../../src/services/tasks/zaps.js'

const SLUG = 'zaps-pagination-proj'

let projectId: number
let hashListId: number
let agentId: number
let taskId: number
// A second, empty hash list reached through its own campaign/task (scenario 4).
let emptyAgentId: number
let emptyTaskId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

/**
 * Drive a full paginated walk through getZapsForTask, echoing back the
 * decoded `nextCursor` exactly as an agent would, and return the ordered
 * list of every zap value seen across all calls.
 */
async function walkAll(
  targetTaskId: number,
  targetAgentId: number,
  limit: number
): Promise<string[]> {
  const seen: string[] = []
  let cursor: ZapCursor | undefined
  // Bound the loop defensively so a pagination bug can't spin forever.
  for (let guard = 0; guard < 1000; guard++) {
    const result = await getZapsForTask(targetTaskId, targetAgentId, projectId, { cursor, limit })
    if ('error' in result) {
      throw new Error(`unexpected error walking zaps: ${result.error}`)
    }
    seen.push(...result.zaps)
    if (result.nextCursor === null) {
      return seen
    }
    cursor = decodeZapCursor(result.nextCursor)
  }
  throw new Error('walkAll did not terminate — possible pagination loop')
}

/**
 * Seed a campaign → attack → agent → task chain pointing at `listId`,
 * assigned to a fresh agent (getZapsForTask checks `tasks.agentId` with
 * no status/lease gate, so an agent set at insert is sufficient). Returns
 * the agent and task ids the zaps lookup needs. `projectId` is read from
 * module scope (the shared project seeded in beforeAll).
 */
async function createTaskFixture(
  listId: number,
  prefix: string
): Promise<{ agentId: number; taskId: number }> {
  const [camp] = await db
    .insert(campaigns)
    .values({
      name: `${prefix}-camp`,
      projectId,
      hashListId: listId,
      priority: 1,
      status: 'running',
      hashcatMode: 0,
    })
    .returning({ id: campaigns.id })
  const [atk] = await db
    .insert(attacks)
    .values({ campaignId: camp!.id, projectId, mode: 0 })
    .returning({ id: attacks.id })
  const [agnt] = await db
    .insert(agents)
    .values({ name: `${prefix}-agent`, projectId, capabilities: { gpu: false }, status: 'online' })
    .returning({ id: agents.id })
  const [task] = await db
    .insert(tasks)
    .values({
      attackId: atk!.id,
      campaignId: camp!.id,
      agentId: agnt!.id,
      status: 'running',
      workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
      requiredCapabilities: { gpu: false },
    })
    .returning({ id: tasks.id })
  return { agentId: agnt!.id, taskId: task!.id }
}

beforeAll(async () => {
  await cleanup()

  const [proj] = await db
    .insert(projects)
    .values({ name: SLUG, slug: SLUG })
    .returning({ id: projects.id })
  projectId = proj!.id

  const [list] = await db
    .insert(hashLists)
    .values({ projectId, name: 'list-zap-pag', status: 'ready' })
    .returning({ id: hashLists.id })
  hashListId = list!.id
  ;({ agentId, taskId } = await createTaskFixture(hashListId, 'zap-pag'))

  // Second campaign/task with an EMPTY hash list (no cracked rows) for scenario 4.
  const [emptyList] = await db
    .insert(hashLists)
    .values({ projectId, name: 'list-zap-empty', status: 'ready' })
    .returning({ id: hashLists.id })
  ;({ agentId: emptyAgentId, taskId: emptyTaskId } = await createTaskFixture(
    emptyList!.id,
    'zap-empty'
  ))
})

afterAll(async () => {
  await cleanup()
})

// Fixed, millisecond-aligned timestamps (KTD3). T_TIED is shared by a
// cluster larger than the walk's `limit`, so it must straddle a page
// boundary; T_BEFORE/T_AFTER bracket the cluster.
const T_BEFORE = new Date(1_752_000_000_000)
const T_TIED = new Date(1_752_000_000_500)
const T_AFTER = new Date(1_752_000_001_000)

describe('getZapsForTask — composite cursor pagination', () => {
  it('walks every cracked hash exactly once across a tied-timestamp cluster larger than limit', async () => {
    // Arrange: 2 rows before the tie, 5 rows sharing ONE crackedAt, 2 after.
    // With limit=3 the 5-row tied cluster cannot fit in one page — it must
    // split across page boundaries without losing or repeating a tied row.
    const before = ['zp-before-1', 'zp-before-2']
    const tied = ['zp-tie-1', 'zp-tie-2', 'zp-tie-3', 'zp-tie-4', 'zp-tie-5']
    const after = ['zp-after-1', 'zp-after-2']
    const expected = [...before, ...tied, ...after]

    await db.insert(hashItems).values([
      ...before.map((hashValue) => ({
        hashListId,
        hashValue,
        plaintext: 'pw',
        crackedAt: T_BEFORE,
      })),
      ...tied.map((hashValue) => ({ hashListId, hashValue, plaintext: 'pw', crackedAt: T_TIED })),
      ...after.map((hashValue) => ({
        hashListId,
        hashValue,
        plaintext: 'pw',
        crackedAt: T_AFTER,
      })),
    ])

    // Act: full walk with a limit smaller than the tied cluster.
    const seen = await walkAll(taskId, agentId, 3)

    // Assert: exactly-once — the multiset of returned values equals the
    // seeded set, with no duplicates and no omissions.
    expect(seen.length).toBe(expected.length)
    expect([...seen].sort()).toEqual([...expected].sort())
    expect(new Set(seen).size).toBe(seen.length) // no duplicates
  })

  it('returns nextCursor: null on the final page, and empty for a cursor past the end', async () => {
    // The final page of a full walk terminates with nextCursor === null
    // (the service never emits a cursor pointing AT the last row).
    let cursor: ZapCursor | undefined
    let pages = 0
    let finalCursor: string | null = 'sentinel'
    for (let guard = 0; guard < 1000; guard++) {
      const result = await getZapsForTask(taskId, agentId, projectId, { cursor, limit: 3 })
      if ('error' in result) throw new Error(result.error)
      pages++
      finalCursor = result.nextCursor
      if (result.nextCursor === null) break
      cursor = decodeZapCursor(result.nextCursor)
    }
    expect(pages).toBeGreaterThan(1) // multi-page walk actually happened
    expect(finalCursor).toBeNull() // clean termination

    // A cursor positioned strictly past every row (max timestamp + max id)
    // yields an empty page with a null cursor — the past-the-end contract.
    const pastEnd: ZapCursor = { crackedAt: T_AFTER, id: 2_147_483_647 }
    const tail = await getZapsForTask(taskId, agentId, projectId, { cursor: pastEnd, limit: 3 })
    if ('error' in tail) throw new Error(tail.error)
    expect(tail.zaps).toEqual([])
    expect(tail.nextCursor).toBeNull()
  })

  it('returns { zaps: [], nextCursor: null } for a hash list with no cracked rows', async () => {
    const result = await getZapsForTask(emptyTaskId, emptyAgentId, projectId, { limit: 3 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('returns exactly-limit rows in a single page with nextCursor: null (boundary)', async () => {
    // Exactly `limit` cracked rows must come back in one call with no
    // continuation token — pins the strict `>` in `rows.length > fetchLimit`.
    const [list] = await db
      .insert(hashLists)
      .values({ projectId, name: 'list-zap-exact', status: 'ready' })
      .returning({ id: hashLists.id })
    const fx = await createTaskFixture(list!.id, 'zap-exact')
    await db.insert(hashItems).values(
      ['ex-1', 'ex-2', 'ex-3'].map((hashValue, idx) => ({
        hashListId: list!.id,
        hashValue,
        plaintext: 'pw',
        crackedAt: new Date(1_752_200_000_000 + idx * 1000),
      }))
    )

    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 3 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual(['ex-1', 'ex-2', 'ex-3'])
    expect(result.nextCursor).toBeNull()
  })

  it('clamps a below-range limit up to 1 rather than returning zero rows', async () => {
    // The service independently clamps `Math.max(limit, 1)`; a limit of 0
    // must still return the first row (and a cursor since more remain), not
    // an empty page.
    const [list] = await db
      .insert(hashLists)
      .values({ projectId, name: 'list-zap-clamp', status: 'ready' })
      .returning({ id: hashLists.id })
    const fx = await createTaskFixture(list!.id, 'zap-clamp')
    await db.insert(hashItems).values(
      ['cl-1', 'cl-2', 'cl-3'].map((hashValue, idx) => ({
        hashListId: list!.id,
        hashValue,
        plaintext: 'pw',
        crackedAt: new Date(1_752_300_000_000 + idx * 1000),
      }))
    )

    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 0 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual(['cl-1'])
    expect(result.nextCursor).not.toBeNull()
  })

  it('moving a row crackedAt forward causes a benign replay, never a skip (KTD4)', async () => {
    // Fresh isolated hash list so the earlier seeded rows don't interfere.
    const [list2] = await db
      .insert(hashLists)
      .values({ projectId, name: 'list-zap-immut', status: 'ready' })
      .returning({ id: hashLists.id })
    const list2Id = list2!.id
    const immut = await createTaskFixture(list2Id, 'zap-immut')

    const all = ['im-1', 'im-2', 'im-3', 'im-4']
    await db.insert(hashItems).values(
      all.map((hashValue, idx) => ({
        hashListId: list2Id,
        hashValue,
        plaintext: 'pw',
        // Distinct ascending timestamps so ordering is unambiguous.
        crackedAt: new Date(1_752_100_000_000 + idx * 1000),
      }))
    )

    // First page (limit 2) — pages past im-1, im-2. Capture the cursor.
    const page1 = await getZapsForTask(immut.taskId, immut.agentId, projectId, { limit: 2 })
    if ('error' in page1) throw new Error(page1.error)
    expect(page1.zaps).toEqual(['im-1', 'im-2'])
    expect(page1.nextCursor).not.toBeNull()

    // Re-crack im-1 (already paged past) by moving its crackedAt FORWARD,
    // beyond every other row — the monotonic-forward mutation of KTD4.
    await db
      .update(hashItems)
      .set({ crackedAt: new Date(1_752_100_099_000) })
      .where(and(eq(hashItems.hashListId, list2Id), eq(hashItems.hashValue, 'im-1')))

    // Continue the walk from the captured cursor (page1) to exhaustion.
    const continued: string[] = []
    let cursor: ZapCursor | undefined = decodeZapCursor(page1.nextCursor!)
    for (let guard = 0; guard < 1000; guard++) {
      const r = await getZapsForTask(immut.taskId, immut.agentId, projectId, { cursor, limit: 2 })
      if ('error' in r) throw new Error(r.error)
      continued.push(...r.zaps)
      if (r.nextCursor === null) break
      cursor = decodeZapCursor(r.nextCursor)
    }

    const seenAcrossWalk = [...page1.zaps, ...continued]

    // No SKIP: every original hash appears at least once across the walk.
    for (const hashValue of all) {
      expect(seenAcrossWalk).toContain(hashValue)
    }
    // Benign REPLAY: im-1 was paged past, moved forward, and reappears —
    // exactly the accepted, documented duplicate (never a skip).
    expect(seenAcrossWalk.filter((h) => h === 'im-1').length).toBe(2)
  })
})
