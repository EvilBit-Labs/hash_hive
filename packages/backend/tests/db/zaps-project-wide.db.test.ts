/**
 * Real-DB tests for U3 — widen zap resolution to the maintained per-project
 * cracked-set at project+mode scope (SuperHashlists Layer one, KTD4 / R8 /
 * R16). These prove the SQL-level behavior only a live Postgres can show and
 * that the widening preserves the agent wire contract + exactly-once cursor:
 *
 *   - AE2 (cross-list zap): lists A and B in ONE project, the same hash `H`
 *     under the same mode. A campaign runs against list A directly (not a
 *     super). Once `H` is cracked (present in the cracked-set at project+mode),
 *     a zap poll for a task under a list-B campaign returns `H` — the value
 *     cracked in a sibling list zaps a task that never targeted that list.
 *   - Mode isolation (reinforces AE1): a value cracked under NTLM (mode 1000)
 *     does NOT appear in the zaps for an MD5-mode (0) task. The dedup key is
 *     `(mode, value)`, not value alone.
 *   - Exactly-once under tied `crackedAt`: many cracked-set rows share ONE
 *     millisecond; a full paginated walk with a `limit` smaller than the tied
 *     cluster returns each value exactly once, none skipped, none repeated —
 *     the property the composite `(crackedAt, id)` cursor exists for, now over
 *     the widened table.
 *   - Wire unchanged: the service still returns `{ zaps: string[], nextCursor:
 *     string | null }` and a null cursor at exhaustion.
 *   - EXPLAIN: the widened scan is an Index Cond seek on
 *     `project_cracked_hashes_keyset_idx` `(projectId, hashcatMode, crackedAt,
 *     id)`, not a Seq Scan — the redundant leading `gte` bound in zaps.ts
 *     relies on this.
 *
 * The cracked-set is populated by DIRECT INSERTS into `project_cracked_hashes`
 * (not by running agents), with `crackedAt` as millisecond-aligned JS `Date`s —
 * matching how the U2 write path stamps the keyset column (KTD2). Each scenario
 * uses its OWN hashcat mode so project+mode scoping isolates it from the others
 * (all fixtures share one project).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */
import {
  agents,
  attacks,
  campaigns,
  hashLists,
  projectCrackedHashes,
  projects,
  tasks,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { decodeZapCursor, type ZapCursor } from '../../src/services/tasks/zap-cursor.js'
import { getZapsForTask } from '../../src/services/tasks/zaps.js'

const SLUG = 'zaps-project-wide-proj'

let projectId: number

async function cleanup(): Promise<void> {
  // Project cascade removes hashLists/campaigns/attacks/tasks/agents and
  // project_cracked_hashes (projectId FK is ON DELETE CASCADE).
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

let seq = 0

/**
 * Create a fresh hash list in the shared project. Returns its id. The list is
 * only a target for a campaign — cracked-set rows are keyed on project+mode,
 * not on this list.
 */
async function createList(prefix: string): Promise<number> {
  seq += 1
  const [list] = await db
    .insert(hashLists)
    .values({ projectId, name: `${prefix}-list-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  return list!.id
}

/**
 * Seed a campaign (latched to `mode` for the composite attacks FK) → attack →
 * agent → running task assigned to that agent, all targeting `listId`. Mirrors
 * the seed chain in `zaps-pagination.db.test.ts`. getZapsForTask reads the
 * campaign's `hashcatMode` and verifies `tasks.agentId` (no status/lease gate),
 * so an agent set at insert is sufficient.
 */
async function createTaskFixture(
  listId: number,
  mode: number,
  prefix: string
): Promise<{ agentId: number; taskId: number }> {
  seq += 1
  const [camp] = await db
    .insert(campaigns)
    .values({
      name: `${prefix}-camp-${seq}`,
      projectId,
      hashListId: listId,
      priority: 1,
      status: 'running',
      hashcatMode: mode,
    })
    .returning({ id: campaigns.id })
  const [atk] = await db
    .insert(attacks)
    .values({ campaignId: camp!.id, projectId, mode })
    .returning({ id: attacks.id })
  const [agnt] = await db
    .insert(agents)
    .values({
      name: `${prefix}-agent-${seq}`,
      projectId,
      capabilities: { gpu: false },
      status: 'online',
    })
    .returning({ id: agents.id })
  const [task] = await db
    .insert(tasks)
    .values({
      attackId: atk!.id,
      campaignId: camp!.id,
      agentId: agnt!.id,
      status: 'running',
      workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
      requiredCapabilities: { gpu: false, hashcatMode: mode },
    })
    .returning({ id: tasks.id })
  return { agentId: agnt!.id, taskId: task!.id }
}

/**
 * Insert a cracked-set row directly (simulating the U2 write path). `crackedAt`
 * is millisecond-aligned, matching how the app stamps the keyset column.
 */
async function seedCracked(
  mode: number,
  hashValue: string,
  crackedAt: Date,
  sourceHashListId?: number
): Promise<void> {
  await db.insert(projectCrackedHashes).values({
    projectId,
    hashcatMode: mode,
    hashValue,
    plaintext: `pw-${hashValue}`,
    crackedAt,
    originalCrackedAt: crackedAt,
    sourceHashListId: sourceHashListId ?? null,
  })
}

/**
 * Drive a full paginated walk through getZapsForTask, echoing back the decoded
 * `nextCursor` exactly as an agent would, and return the ordered list of every
 * zap value seen across all calls.
 */
async function walkAll(
  targetTaskId: number,
  targetAgentId: number,
  limit: number
): Promise<string[]> {
  const seen: string[] = []
  let cursor: ZapCursor | undefined
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

beforeAll(async () => {
  await cleanup()
  const [proj] = await db.insert(projects).values({ name: SLUG, slug: SLUG }).returning({
    id: projects.id,
  })
  projectId = proj!.id
})

afterAll(cleanup)

describe('getZapsForTask — project+mode cracked-set resolution (U3 / KTD4)', () => {
  it('AE2: a value cracked in list A zaps a task under a list-B campaign in the same project', async () => {
    const MODE = 100
    const listA = await createList('ae2-a')
    const listB = await createList('ae2-b')
    // The crack happened in list A (sourceHashListId), but the polling task
    // targets list B. Under the OLD single-list scan this would return nothing;
    // under project+mode resolution it must return H.
    await seedCracked(MODE, 'ae2-shared-H', new Date(1_760_000_000_000), listA)

    const fxB = await createTaskFixture(listB, MODE, 'ae2-b')
    const result = await getZapsForTask(fxB.taskId, fxB.agentId, projectId, { limit: 10 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual(['ae2-shared-H'])
    expect(result.nextCursor).toBeNull()
  })

  it('mode isolation: an NTLM crack does not appear in the zaps for an MD5-mode task (reinforces AE1)', async () => {
    const MODE_MD5 = 0
    const MODE_NTLM = 1000
    const value = 'mode-iso-X'
    // Same value cracked under NTLM only.
    await seedCracked(MODE_NTLM, value, new Date(1_760_100_000_000))

    // A task whose campaign is latched to MD5 must not see the NTLM crack.
    const listMd5 = await createList('mode-iso-md5')
    const fxMd5 = await createTaskFixture(listMd5, MODE_MD5, 'mode-iso-md5')
    const md5Res = await getZapsForTask(fxMd5.taskId, fxMd5.agentId, projectId, { limit: 10 })
    if ('error' in md5Res) throw new Error(md5Res.error)
    expect(md5Res.zaps).not.toContain(value)

    // Sanity: the SAME value IS a zap for an NTLM-mode task — proving the miss
    // above is mode isolation, not a missing row.
    const listNtlm = await createList('mode-iso-ntlm')
    const fxNtlm = await createTaskFixture(listNtlm, MODE_NTLM, 'mode-iso-ntlm')
    const ntlmRes = await getZapsForTask(fxNtlm.taskId, fxNtlm.agentId, projectId, { limit: 10 })
    if ('error' in ntlmRes) throw new Error(ntlmRes.error)
    expect(ntlmRes.zaps).toContain(value)
  })

  it('walks every cracked value exactly once across a tied-crackedAt cluster larger than limit', async () => {
    const MODE = 200
    const list = await createList('tied')
    const fx = await createTaskFixture(list, MODE, 'tied')

    // 2 rows before the tie, 5 sharing ONE crackedAt, 2 after. With limit=3 the
    // 5-row tied cluster cannot fit in one page — it must split across page
    // boundaries without losing or repeating a tied row.
    const T_BEFORE = new Date(1_760_200_000_000)
    const T_TIED = new Date(1_760_200_000_500)
    const T_AFTER = new Date(1_760_200_001_000)
    const before = ['pw-before-1', 'pw-before-2']
    const tied = ['pw-tie-1', 'pw-tie-2', 'pw-tie-3', 'pw-tie-4', 'pw-tie-5']
    const after = ['pw-after-1', 'pw-after-2']
    const expected = [...before, ...tied, ...after]

    for (const v of before) await seedCracked(MODE, v, T_BEFORE)
    for (const v of tied) await seedCracked(MODE, v, T_TIED)
    for (const v of after) await seedCracked(MODE, v, T_AFTER)

    const seen = await walkAll(fx.taskId, fx.agentId, 3)

    // Exactly-once: the multiset of returned values equals the seeded set, with
    // no duplicates and no omissions.
    expect(seen.length).toBe(expected.length)
    expect([...seen].sort()).toEqual([...expected].sort())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('wire unchanged: returns { zaps, nextCursor } with a null cursor at exhaustion', async () => {
    const MODE = 300
    const list = await createList('wire')
    const fx = await createTaskFixture(list, MODE, 'wire')
    await seedCracked(MODE, 'wire-a', new Date(1_760_300_000_000))
    await seedCracked(MODE, 'wire-b', new Date(1_760_300_001_000))

    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 10 })
    if ('error' in result) throw new Error(result.error)
    // Shape: { zaps: string[], nextCursor: string | null }.
    expect(Array.isArray(result.zaps)).toBe(true)
    expect(result.zaps.every((z) => typeof z === 'string')).toBe(true)
    expect(result.zaps).toEqual(['wire-a', 'wire-b'])
    expect(result.nextCursor).toBeNull()
  })

  it('resolution is mode-scoped, never project-wide: a same-project row under a different mode never leaks in', async () => {
    const MODE = 400
    const OTHER_MODE = 401
    const list = await createList('scoped')
    const fx = await createTaskFixture(list, MODE, 'scoped')
    // One row at the task's mode, one same-project decoy under a different mode.
    await seedCracked(MODE, 'scoped-hit', new Date(1_760_400_000_000))
    await seedCracked(OTHER_MODE, 'scoped-decoy', new Date(1_760_400_000_500))

    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 10 })
    if ('error' in result) throw new Error(result.error)
    // Only the task's own mode is returned — the decoy in the same project but a
    // different mode is excluded (the scan is `projectId = ? AND hashcatMode = ?`,
    // not a project-wide read). NOTE: the null-mode early return in the service
    // (campaign with no attacks) is defensive and unreachable with real rows —
    // a task always descends from an attack that latches the campaign mode, and
    // the composite attacks->campaigns FK blocks clearing it back to NULL.
    expect(result.zaps).toEqual(['scoped-hit'])
    expect(result.nextCursor).toBeNull()
  })

  it('returns "task not found" for a task id from another project (project scope via join)', async () => {
    const MODE = 500
    const list = await createList('scope')
    const fx = await createTaskFixture(list, MODE, 'scope')
    // Same task/agent but a bogus projectId → the campaigns.projectId join misses.
    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId + 999_999, { limit: 10 })
    expect('error' in result).toBe(true)
  })

  it('EXPLAIN: the widened scan is an Index Cond seek on the keyset index, not a Seq Scan', async () => {
    const MODE = 600
    // Seed a batch so the planner has a populated table to reason about.
    for (let i = 0; i < 50; i++) {
      await seedCracked(MODE, `explain-${i}`, new Date(1_760_600_000_000 + i * 1000))
    }
    // `enable_seqscan = off` (transaction-local) makes this deterministic:
    // on a small table the planner would otherwise prefer a Seq Scan on
    // row-count cost alone, making a bare EXPLAIN assertion flaky. Disabling
    // seq scan proves the load-bearing property KTD4 promises — the keyset
    // index is APPLICABLE to this query shape as an Index Cond seek (what the
    // redundant `gte` bound in zaps.ts relies on).
    const planText = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`)
      const plan = await tx.execute(sql`
        EXPLAIN
        SELECT hash_value, id, cracked_at
        FROM project_cracked_hashes
        WHERE project_id = ${projectId} AND hashcat_mode = ${MODE} AND cracked_at IS NOT NULL
        ORDER BY cracked_at ASC, id ASC
        LIMIT 100
      `)
      return (plan as unknown as Array<Record<string, string>>)
        .map((r) => Object.values(r).join(' '))
        .join('\n')
    })
    expect(planText).toContain('project_cracked_hashes_keyset_idx')
    expect(planText).not.toContain('Seq Scan')
  })
})
