/**
 * Real-DB tests for U11 (KTD-5): lease stamping, reclaim, one-active-lease
 * invariant, ghost detection, and race safety.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts).
 * Every describe block calls cleanupSeed() in afterAll so runs are
 * idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane test files share the same client.
 */

import { agents, attacks, campaigns, hashLists, hashTypes, projects, tasks } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { assignNextTask, updateTaskProgress } from '../../src/services/tasks.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_SLUG_LEASE = 'tasks-lease-test-proj'
const HASHCAT_MODE_LEASE = 9_999_811 // unique to this test file

// ─── Seed helpers ───────────────────────────────────────────────────────────

interface SeedResult {
  projectId: number
  agentAId: number
  agentBId: number
  campaignId: number
  attackId: number
}

async function seedFixture(): Promise<SeedResult> {
  const [project] = await db
    .insert(projects)
    .values({ name: 'tasks-lease-test-proj', slug: TEST_SLUG_LEASE })
    .returning({ id: projects.id })

  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'MD5 (lease test)', hashcatMode: HASHCAT_MODE_LEASE })
    .returning({ id: hashTypes.id })

  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId: project!.id,
      name: 'lease-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })

  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: 'lease-test-campaign',
      projectId: project!.id,
      hashListId: hashList!.id,
      priority: 1,
      status: 'running',
    })
    .returning({ id: campaigns.id })

  const [attack] = await db
    .insert(attacks)
    .values({
      campaignId: campaign!.id,
      projectId: project!.id,
      mode: 0,
    })
    .returning({ id: attacks.id })

  // Two agents so we can test one-per-agent invariant and race scenarios.
  // Use `gpu: false` explicitly so the buildCapabilityPredicate GPU check
  // evaluates to TRUE (NOT ('false'='true')) rather than NULL (NOT NULL),
  // which would make the whole predicate NULL and silently filter out tasks.
  const [agentA] = await db
    .insert(agents)
    .values({
      name: 'lease-agent-a',
      projectId: project!.id,
      capabilities: { gpu: false },
      status: 'online',
    })
    .returning({ id: agents.id })

  const [agentB] = await db
    .insert(agents)
    .values({
      name: 'lease-agent-b',
      projectId: project!.id,
      capabilities: { gpu: false },
      status: 'online',
    })
    .returning({ id: agents.id })

  return {
    projectId: project!.id,
    agentAId: agentA!.id,
    agentBId: agentB!.id,
    campaignId: campaign!.id,
    attackId: attack!.id,
  }
}

async function cleanupSeed(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG_LEASE))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, HASHCAT_MODE_LEASE))
}

/** Insert a fresh pending task and return its ID.
 *
 * requiredCapabilities uses `{ gpu: false }` explicitly so the
 * buildCapabilityPredicate GPU check evaluates to TRUE
 * (NOT ('false'='true')) rather than NULL (NOT NULL). A missing GPU key
 * causes `required_capabilities->>'gpu'` to return NULL, which makes
 * the whole AND predicate NULL and silently filters the task out.
 */
async function insertPendingTask(attackId: number, campaignId: number): Promise<number> {
  const [task] = await db
    .insert(tasks)
    .values({
      attackId,
      campaignId,
      status: 'pending',
      workRange: { start: 0, end: 999, total: 1000 },
      requiredCapabilities: { gpu: false },
    })
    .returning({ id: tasks.id })
  return task!.id
}

/** Insert a task already "assigned" to agentId with a custom lease. */
async function insertAssignedTask(
  attackId: number,
  campaignId: number,
  agentId: number,
  leaseExpiresAt: Date | null
): Promise<number> {
  const [task] = await db
    .insert(tasks)
    .values({
      attackId,
      campaignId,
      agentId,
      status: 'assigned',
      assignedAt: new Date(),
      workRange: { start: 0, end: 999, total: 1000 },
      leaseExpiresAt,
      requiredCapabilities: { gpu: false },
    })
    .returning({ id: tasks.id })
  return task!.id
}

/** Read lease_expires_at directly from the DB for a task. */
async function readLeaseExpiresAt(taskId: number): Promise<Date | null> {
  const [row] = await db
    .select({ leaseExpiresAt: tasks.leaseExpiresAt })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  return row?.leaseExpiresAt ?? null
}

/** Read task status and agentId from the DB. */
async function readTaskState(
  taskId: number
): Promise<{ status: string; agentId: number | null } | null> {
  const [row] = await db
    .select({ status: tasks.status, agentId: tasks.agentId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  if (!row) return null
  return { status: row.status, agentId: row.agentId ?? null }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

let fix: SeedResult

beforeAll(async () => {
  await cleanupSeed()
  fix = await seedFixture()
})

afterAll(async () => {
  await cleanupSeed()
})

describe('U11 lease stamping — claim sets lease_expires_at', () => {
  it('assignNextTask stamps lease_expires_at ~90s in the future', async () => {
    const taskId = await insertPendingTask(fix.attackId, fix.campaignId)
    const before = new Date()
    const assigned = await assignNextTask(fix.agentAId)
    const after = new Date()

    expect(assigned).not.toBeNull()
    expect(assigned!.id).toBe(taskId)

    const lease = await readLeaseExpiresAt(taskId)
    expect(lease).not.toBeNull()
    // Lease should be ~90s from call time — allow generous ±5s window for slow CI.
    const leaseMs = lease!.getTime()
    expect(leaseMs).toBeGreaterThanOrEqual(before.getTime() + 85_000)
    expect(leaseMs).toBeLessThanOrEqual(after.getTime() + 95_000)

    // Cleanup: release the task so it doesn't block subsequent tests.
    await db.delete(tasks).where(eq(tasks.id, taskId))
  })
})

describe('U11 lease reclaim — expired-lease task claimed by next agent', () => {
  it('agent B reclaims a task whose lease expired while held by agent A', async () => {
    // Arrange: task already assigned to A with an expired lease.
    const pastLease = new Date(Date.now() - 1_000) // 1 second ago
    const taskId = await insertAssignedTask(fix.attackId, fix.campaignId, fix.agentAId, pastLease)

    // Act: B tries to claim — the CTE should see the expired-lease row.
    const assigned = await assignNextTask(fix.agentBId)

    // Assert: B got the task and the lease was refreshed.
    expect(assigned).not.toBeNull()
    expect(assigned!.id).toBe(taskId)
    expect(assigned!.agentId).toBe(fix.agentBId)

    const state = await readTaskState(taskId)
    expect(state?.agentId).toBe(fix.agentBId)
    expect(state?.status).toBe('assigned')

    const lease = await readLeaseExpiresAt(taskId)
    expect(lease).not.toBeNull()
    expect(lease!.getTime()).toBeGreaterThan(Date.now() + 80_000)

    await db.delete(tasks).where(eq(tasks.id, taskId))
  })
})

describe('U11 one-active-lease-per-agent invariant', () => {
  it('agent with a live lease cannot claim a second task', async () => {
    // Arrange: A holds a task with a live lease.
    const futureLease = new Date(Date.now() + 90_000)
    const taskId1 = await insertAssignedTask(
      fix.attackId,
      fix.campaignId,
      fix.agentAId,
      futureLease
    )
    // A second pending task is available.
    const taskId2 = await insertPendingTask(fix.attackId, fix.campaignId)

    // Act: A tries to claim a second task.
    const result = await assignNextTask(fix.agentAId)

    // Assert: one-per-agent guard (NOT EXISTS) blocks the second claim
    // because A already holds a live lease on taskId1.
    expect(result).toBeNull()

    // The second task is still pending.
    const state = await readTaskState(taskId2)
    expect(state?.status).toBe('pending')

    await db.delete(tasks).where(eq(tasks.id, taskId1))
    await db.delete(tasks).where(eq(tasks.id, taskId2))
  })

  it('agent with an expired lease CAN claim a new task', async () => {
    // Arrange: A's previous task had a lease that is now expired.
    const pastLease = new Date(Date.now() - 1_000)
    const taskId1 = await insertAssignedTask(fix.attackId, fix.campaignId, fix.agentAId, pastLease)
    // A fresh pending task is available.
    const taskId2 = await insertPendingTask(fix.attackId, fix.campaignId)

    // Act: A tries to claim — the expired task makes it eligible.
    // The CTE will reclaim taskId1 (lowest id, same campaign) or taskId2.
    const result = await assignNextTask(fix.agentAId)

    // Assert: A got one of the two tasks (whichever the CTE picked).
    expect(result).not.toBeNull()
    expect([taskId1, taskId2]).toContain(result!.id)

    await db.delete(tasks).where(eq(tasks.id, taskId1))
    await db.delete(tasks).where(eq(tasks.id, taskId2))
  })
})

describe('U11 ghost detection — lease extends only on watermark advance', () => {
  it('non-advancing report does NOT extend the lease', async () => {
    // Arrange: task with a short lease (5s from now).
    const shortLease = new Date(Date.now() + 5_000)
    const taskId = await insertAssignedTask(fix.attackId, fix.campaignId, fix.agentAId, shortLease)

    // Act: report with keyspaceProgress = 100 twice (no advance on second call).
    // First call sets progress.
    await db
      .update(tasks)
      .set({ status: 'running', progress: { keyspaceProgress: 100 } })
      .where(eq(tasks.id, taskId))

    // Second call: same keyspaceProgress = 100 → watermark does NOT advance.
    await updateTaskProgress(taskId, fix.agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 100 },
    })

    const leaseAfter = await readLeaseExpiresAt(taskId)
    expect(leaseAfter).not.toBeNull()
    // Lease should remain near the short ~5s window, not jump to ~90s.
    // Allow ±2s for slow CI. If lease DID extend it would be ~90s from now.
    expect(leaseAfter!.getTime()).toBeLessThan(Date.now() + 10_000)

    await db.delete(tasks).where(eq(tasks.id, taskId))
  })

  it('advancing watermark DOES extend the lease', async () => {
    // Arrange: task with a short lease (5s from now), progress at 50.
    const shortLease = new Date(Date.now() + 5_000)
    const taskId = await insertAssignedTask(fix.attackId, fix.campaignId, fix.agentAId, shortLease)
    await db
      .update(tasks)
      .set({ status: 'running', progress: { keyspaceProgress: 50 } })
      .where(eq(tasks.id, taskId))

    // Act: report with keyspaceProgress = 200 (strictly > 50 → advance).
    await updateTaskProgress(taskId, fix.agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 200 },
    })

    const leaseAfter = await readLeaseExpiresAt(taskId)
    expect(leaseAfter).not.toBeNull()
    // Lease should have jumped to ~90s from now.
    expect(leaseAfter!.getTime()).toBeGreaterThan(Date.now() + 80_000)

    await db.delete(tasks).where(eq(tasks.id, taskId))
  })
})

describe('U11 race safety — lapsed-lease report is a no-op', () => {
  it('updateTaskProgress from agent with expired lease matches zero rows', async () => {
    // Arrange: task assigned to A with already-expired lease.
    const expiredLease = new Date(Date.now() - 1_000)
    const taskId = await insertAssignedTask(
      fix.attackId,
      fix.campaignId,
      fix.agentAId,
      expiredLease
    )

    // Act: A reports progress after its lease has lapsed.
    const result = await updateTaskProgress(taskId, fix.agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 500 },
    })

    // Assert: zero-row UPDATE → error result, task unchanged.
    expect(result).toHaveProperty('error')

    const state = await readTaskState(taskId)
    // Status should still be 'assigned', progress untouched.
    expect(state?.status).toBe('assigned')

    await db.delete(tasks).where(eq(tasks.id, taskId))
  })
})

describe('U11 concurrency — only one agent wins an expired-lease task', () => {
  it('sequential claims on one expired-lease task: first wins, second gets null', async () => {
    // Arrange: one expired-lease task available.
    const expiredLease = new Date(Date.now() - 1_000)
    const taskId = await insertAssignedTask(
      fix.attackId,
      fix.campaignId,
      fix.agentAId,
      expiredLease
    )

    // Act: B and A (with expired lease, not live) race to reclaim.
    // Sequential here because the shared pool serialises; SKIP LOCKED makes the
    // structural guarantee: the loser gets null rather than a duplicate claim.
    const firstWin = await assignNextTask(fix.agentBId)
    const secondTry = await assignNextTask(fix.agentAId)

    // Assert: exactly one winner.
    expect(firstWin).not.toBeNull()
    expect(firstWin!.id).toBe(taskId)
    // B won the race; no claimable task remains for A (SKIP LOCKED sees nothing).
    expect(secondTry).toBeNull()

    await db.delete(tasks).where(eq(tasks.id, taskId))
  })

  it('concurrent claims (Promise.all) on one expired-lease task: exactly one wins', async () => {
    const expiredLease = new Date(Date.now() - 1_000)
    const taskId = await insertAssignedTask(
      fix.attackId,
      fix.campaignId,
      fix.agentAId,
      expiredLease
    )

    // Two agents race concurrently (separate pool connections). SKIP LOCKED must
    // let exactly one claim the single expired-lease task — never a double-claim.
    const results = await Promise.all([assignNextTask(fix.agentBId), assignNextTask(fix.agentAId)])
    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.id).toBe(taskId)

    // The row ends owned by exactly one agent.
    const [owned] = await db
      .select({ owner: tasks.agentId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    expect([fix.agentAId, fix.agentBId]).toContain(owned!.owner)

    await db.delete(tasks).where(eq(tasks.id, taskId))
  })
})
