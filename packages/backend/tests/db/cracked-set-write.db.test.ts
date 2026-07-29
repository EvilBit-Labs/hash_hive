/**
 * Real-DB tests for U2 — maintain the project-wide cracked-set on every crack
 * (write path). SuperHashlists Layer one, KTD1/KTD2/KTD3.
 *
 * `updateTaskProgress` (tasks.ts) now upserts a `project_cracked_hashes` row
 * keyed `(projectId, resolvedHashcatMode, hashValue)` atomically with the
 * per-list `hash_items` upsert, and `upsertCrackedSet` (cracked-set.ts) is the
 * primitive that performs it. These tests prove the SQL-level behavior the
 * mocked route/contract tests cannot:
 *   - Happy path: a crack writes both the hash_items row and the cracked-set row.
 *   - Atomic dual-write: a forced failure on the cracked-set write rolls back the
 *     hash_items write in the same transaction (no half-state).
 *   - AE1 mode-keyed distinctness: the same hashValue under two hashcat modes
 *     produces two distinct cracked-set rows; neither marks the other.
 *   - KTD2 monotonicity: a re-crack refreshes `plaintext` but never moves the
 *     keyset column `crackedAt`.
 *   - KTD2 app-Date: `crackedAt` is the application `Date`, not a DB default.
 *   - KTD3 mode gate: a result with no resolved hashcat mode is not written to
 *     the cracked-set (but is still persisted to hash_items).
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
  hashItems,
  hashLists,
  projectCrackedHashes,
  projects,
  tasks,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { upsertCrackedSet } from '../../src/services/hash-items/cracked-set.js'
import { updateTaskProgress } from '../../src/services/tasks.js'

const SLUG = 'cracked-set-write-test-proj'

let projectId = 0

async function cleanup(): Promise<void> {
  // Project cascade removes hashLists/hash_items/campaigns/attacks/tasks/agents
  // and project_cracked_hashes (projectId FK is ON DELETE CASCADE).
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

interface CrackTask {
  taskId: number
  agentId: number
  hashListId: number
  campaignId: number
}

let seq = 0

/**
 * Build a full crack pipeline for one mode: hash list → campaign (latched to
 * `mode` for the composite attacks FK) → attack → agent → running task assigned
 * to that agent. `includeMode` controls whether the task's
 * requiredCapabilities carries `hashcatMode` — omitting it simulates a task
 * generated with no resolvable mode (KTD3).
 */
async function setupCrackTask(mode: number, includeMode = true): Promise<CrackTask> {
  seq += 1
  const [hashList] = await db
    .insert(hashLists)
    .values({ projectId, name: `cs-list-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  const hashListId = hashList!.id

  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: `cs-camp-${seq}`,
      projectId,
      hashListId,
      priority: 1,
      status: 'running',
      // Composite FK attacks(campaign_id, mode) → campaigns(id, hashcat_mode).
      hashcatMode: mode,
    })
    .returning({ id: campaigns.id })
  const campaignId = campaign!.id

  const [attack] = await db
    .insert(attacks)
    .values({ campaignId, projectId, mode })
    .returning({ id: attacks.id })
  const attackId = attack!.id

  const [agent] = await db
    .insert(agents)
    .values({ name: `cs-agent-${seq}`, projectId, capabilities: { gpu: false }, status: 'online' })
    .returning({ id: agents.id })
  const agentId = agent!.id

  const [task] = await db
    .insert(tasks)
    .values({
      attackId,
      campaignId,
      agentId,
      status: 'running',
      workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
      // updateTaskProgress resolves the mode from requiredCapabilities->>'hashcatMode'.
      requiredCapabilities: includeMode ? { gpu: false, hashcatMode: mode } : { gpu: false },
    })
    .returning({ id: tasks.id })

  return { taskId: task!.id, agentId, hashListId, campaignId }
}

beforeAll(async () => {
  await cleanup()
  const [project] = await db
    .insert(projects)
    .values({ name: SLUG, slug: SLUG })
    .returning({ id: projects.id })
  projectId = project!.id
})

afterAll(cleanup)

describe('U2 cracked-set write path — updateTaskProgress', () => {
  it('happy path: a crack writes both the hash_items row and the cracked-set row', async () => {
    const { taskId, agentId, hashListId } = await setupCrackTask(1000)
    const hashValue = 'cs-happy-hash-v1'

    const res = await updateTaskProgress(taskId, agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'hunter2' }],
    })
    expect('error' in res).toBe(false)

    // hash_items row landed with the resolved mode stamped (KTD3).
    const [item] = await db
      .select({
        plaintext: hashItems.plaintext,
        crackedAt: hashItems.crackedAt,
        detectedHashcatMode: hashItems.detectedHashcatMode,
      })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, hashListId), eq(hashItems.hashValue, hashValue)))
    expect(item!.plaintext).toBe('hunter2')
    expect(item!.crackedAt).toBeInstanceOf(Date)
    expect(item!.detectedHashcatMode).toBe(1000)

    // cracked-set row landed under (project, 1000, value).
    const csRows = await db
      .select()
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, 1000),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )
    expect(csRows).toHaveLength(1)
    expect(csRows[0]!.plaintext).toBe('hunter2')
    expect(csRows[0]!.sourceHashListId).toBe(hashListId)
    expect(csRows[0]!.taskId).toBe(taskId)
    expect(csRows[0]!.agentId).toBe(agentId)
  })

  it('AE1: the same value under two modes produces two distinct cracked-set rows; neither marks the other', async () => {
    const hashValue = 'cs-ae1-shared-value-v1'

    const ntlm = await setupCrackTask(1000)
    const md5 = await setupCrackTask(0)

    await updateTaskProgress(ntlm.taskId, ntlm.agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'ntlm-plain' }],
    })
    await updateTaskProgress(md5.taskId, md5.agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'md5-plain' }],
    })

    const rows = await db
      .select({
        hashcatMode: projectCrackedHashes.hashcatMode,
        plaintext: projectCrackedHashes.plaintext,
      })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )
    expect(rows).toHaveLength(2)
    const byMode = new Map(rows.map((r) => [r.hashcatMode, r.plaintext]))
    expect(byMode.get(1000)).toBe('ntlm-plain')
    expect(byMode.get(0)).toBe('md5-plain')
  })

  it('KTD2: a re-crack refreshes plaintext but does NOT move crackedAt', async () => {
    const { taskId, agentId } = await setupCrackTask(1000)
    const hashValue = 'cs-recrack-hash-v1'

    await updateTaskProgress(taskId, agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'first' }],
    })
    const [firstRow] = await db
      .select({ crackedAt: projectCrackedHashes.crackedAt })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, 1000),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )
    const firstCrackedAt = firstRow!.crackedAt!.toISOString()

    // Delay so a (wrong) crackedAt = EXCLUDED.cracked_at conflict SET would
    // produce a strictly later timestamp — makes the no-move assertion real.
    await new Promise((r) => setTimeout(r, 10))

    await updateTaskProgress(taskId, agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'second' }],
    })
    const [secondRow] = await db
      .select({
        crackedAt: projectCrackedHashes.crackedAt,
        plaintext: projectCrackedHashes.plaintext,
      })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, 1000),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )

    // plaintext refreshed, crackedAt unchanged (KTD2 monotonicity).
    expect(secondRow!.plaintext).toBe('second')
    expect(secondRow!.crackedAt!.toISOString()).toBe(firstCrackedAt)
  })

  it('KTD2: crackedAt is the application Date (not a DB default) and originalCrackedAt equals it on first crack', async () => {
    const { taskId, agentId, hashListId } = await setupCrackTask(1000)
    const hashValue = 'cs-appdate-hash-v1'

    const before = Date.now()
    await updateTaskProgress(taskId, agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'plain' }],
    })
    const after = Date.now()

    const [csRow] = await db
      .select({
        crackedAt: projectCrackedHashes.crackedAt,
        originalCrackedAt: projectCrackedHashes.originalCrackedAt,
      })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, 1000),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )
    const [item] = await db
      .select({ crackedAt: hashItems.crackedAt })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, hashListId), eq(hashItems.hashValue, hashValue)))

    const csMs = csRow!.crackedAt!.getTime()
    // Stamped from the application clock during the request window.
    expect(csMs).toBeGreaterThanOrEqual(before - 1000)
    expect(csMs).toBeLessThanOrEqual(after + 1000)
    // Aligned with the sibling hash_items crack (both app `new Date()` in one txn).
    expect(Math.abs(csMs - item!.crackedAt!.getTime())).toBeLessThan(1000)
    // First-crack provenance mirrors the keyset column on insert (KTD2).
    expect(csRow!.originalCrackedAt!.toISOString()).toBe(csRow!.crackedAt!.toISOString())
  })

  it('bug fix (Major): a single report with a DUPLICATE (mode, value) result succeeds and writes exactly one cracked-set row', async () => {
    // Before the fix, the bulk hash_items upsert AND the (former) per-row
    // cracked-set loop would each try to affect the same ON CONFLICT target
    // row twice in one statement/transaction -- Postgres rejects that,
    // rolling back the WHOLE report (including any other, non-duplicate
    // result it carried). A report with a duplicate result -- e.g. a
    // retried/duplicated agent report -- must succeed, deduped, not 500.
    const { taskId, agentId, hashListId } = await setupCrackTask(1000)
    const hashValue = 'cs-dup-report-hash-v1'

    const res = await updateTaskProgress(taskId, agentId, {
      status: 'running',
      results: [
        { hashValue, plaintext: 'first-occurrence' },
        { hashValue, plaintext: 'last-occurrence' },
      ],
    })
    expect('error' in res).toBe(false)

    // hash_items: one row, last occurrence wins.
    const items = await db
      .select({ plaintext: hashItems.plaintext })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, hashListId), eq(hashItems.hashValue, hashValue)))
    expect(items).toHaveLength(1)
    expect(items[0]!.plaintext).toBe('last-occurrence')

    // cracked-set: exactly one row, also last occurrence.
    const csRows = await db
      .select({ plaintext: projectCrackedHashes.plaintext })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, 1000),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )
    expect(csRows).toHaveLength(1)
    expect(csRows[0]!.plaintext).toBe('last-occurrence')
  })

  it('KTD3: a crack with no resolved hashcat mode is persisted to hash_items but NOT to the cracked-set', async () => {
    const { taskId, agentId, hashListId } = await setupCrackTask(0, /* includeMode */ false)
    const hashValue = 'cs-nomode-hash-v1'

    await updateTaskProgress(taskId, agentId, {
      status: 'running',
      results: [{ hashValue, plaintext: 'no-mode-plain' }],
    })

    // hash_items row exists (list-local crack survives) with no stamped mode.
    const [item] = await db
      .select({
        plaintext: hashItems.plaintext,
        detectedHashcatMode: hashItems.detectedHashcatMode,
      })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, hashListId), eq(hashItems.hashValue, hashValue)))
    expect(item!.plaintext).toBe('no-mode-plain')
    expect(item!.detectedHashcatMode).toBeNull()

    // No cracked-set row for this value in the project (no resolvable mode).
    const csRows = await db
      .select()
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashValue, hashValue)
        )
      )
    expect(csRows).toHaveLength(0)
  })
})

describe('U2 cracked-set write path — atomic dual-write (upsertCrackedSet in caller txn)', () => {
  it('rolls back the hash_items write when the cracked-set write fails in the same transaction', async () => {
    const { hashListId } = await setupCrackTask(1000)
    const hashValue = 'cs-rollback-hash-v1'
    const NONEXISTENT_PROJECT_ID = 2_000_000_000 // no such project → FK violation

    let threw = false
    try {
      await db.transaction(async (tx) => {
        // First write: a valid hash_items insert.
        await tx.insert(hashItems).values({
          hashListId,
          hashValue,
          plaintext: 'should-roll-back',
          crackedAt: new Date(),
        })
        // Second write: forced failure — projectId FK does not resolve.
        await upsertCrackedSet(tx, {
          projectId: NONEXISTENT_PROJECT_ID,
          hashcatMode: 1000,
          hashValue,
          plaintext: 'should-roll-back',
        })
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(true)

    // The hash_items insert must have rolled back with the failed cracked-set write.
    const items = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, hashListId), eq(hashItems.hashValue, hashValue)))
    expect(items).toHaveLength(0)
  })
})
