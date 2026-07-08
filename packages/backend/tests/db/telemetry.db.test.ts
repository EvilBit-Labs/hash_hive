/**
 * Real-DB tests for the task_telemetry table and `appendTaskTelemetry`.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts).
 * Every describe block manages its own seed rows; `cleanupSeed` removes them
 * in `afterAll` so runs are idempotent and order-independent.
 *
 * NOTE: do NOT call `client.end()` here — `harness.test.ts` owns the shared
 * drizzle client lifecycle and closes it in its own `afterAll`.  All test
 * files in the `tests/db` lane share the same module-level client.
 */

import {
  agents,
  attacks,
  campaigns,
  hashLists,
  hashTypes,
  projects,
  taskTelemetry,
  tasks,
  users,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { appendTaskTelemetry } from '../../src/services/telemetry.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_EMAIL = 'telemetry-db-test@hashhive.local'
const TEST_SLUG = 'telemetry-test-proj'

// ─── Seed helpers ───────────────────────────────────────────────────────────

interface SeedResult {
  userId: number
  projectId: number
  agentId: number
  campaignId: number
  attackId: number
  taskId: number
}

/** Minimal seed: inserts the minimum required rows and returns their IDs. */
async function seedMinimal(): Promise<SeedResult> {
  const [user] = await db
    .insert(users)
    .values({
      email: TEST_EMAIL,
      passwordHash: 'x',
      name: 'Telemetry Test User',
    })
    .returning({ id: users.id })

  const [project] = await db
    .insert(projects)
    .values({ name: 'telemetry-test-proj', slug: TEST_SLUG, createdBy: user!.id })
    .returning({ id: projects.id })

  const [agent] = await db
    .insert(agents)
    .values({
      name: 'telemetry-test-agent',
      projectId: project!.id,
      capabilities: {},
      status: 'idle',
    })
    .returning({ id: agents.id })

  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'MD5 (telemetry test)', hashcatMode: 9999900 })
    .returning({ id: hashTypes.id })

  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId: project!.id,
      name: 'telemetry-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })

  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: 'telemetry-test-campaign',
      projectId: project!.id,
      hashListId: hashList!.id,
      priority: 1,
      status: 'running',
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // the attack inserted below (mode 0) — see schema.ts's
      // `attacks_campaign_id_mode_..._fk`.
      hashcatMode: 0,
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

  const [task] = await db
    .insert(tasks)
    .values({
      attackId: attack!.id,
      campaignId: campaign!.id,
      agentId: agent!.id,
      status: 'running',
      workRange: { start: 0, end: 999, total: 1000 },
    })
    .returning({ id: tasks.id })

  return {
    userId: user!.id,
    projectId: project!.id,
    agentId: agent!.id,
    campaignId: campaign!.id,
    attackId: attack!.id,
    taskId: task!.id,
  }
}

/** Remove all seed rows for this test run. Cascades handle child rows. */
async function cleanupSeed(): Promise<void> {
  // Deleting the user cascades to projects → agents → campaigns → attacks → tasks.
  await db.delete(users).where(eq(users.email, TEST_EMAIL))
  // hash_types are not cascaded from user; clean up explicitly.
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, 9999900))
  // Guard: also delete the project by slug in case a prior run left orphaned
  // rows (e.g. the user was deleted but the project was not due to a cascade
  // ordering edge case in the test DB). Idempotent if nothing matches.
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('task_telemetry table', () => {
  it('table exists in the schema', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'task_telemetry'
    `)
    expect(rows.length).toBe(1)
  })

  it('has no PRIMARY KEY or UNIQUE constraints', async () => {
    const rows = await db.execute<{ constraint_type: string }>(sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.table_name   = 'task_telemetry'
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    `)
    expect(rows.length).toBe(0)
  })
})

describe('appendTaskTelemetry', () => {
  let seed: SeedResult

  beforeAll(async () => {
    // Purge any residue from prior failed runs before seeding fresh rows.
    await cleanupSeed()
    seed = await seedMinimal()
  })

  it('dual-write: a failing telemetry insert rolls back the sibling task UPDATE (no divergence)', async () => {
    // The U4 dual-write wraps the hot-row task UPDATE and the telemetry INSERT in
    // one transaction so the two stores never diverge. Force the telemetry INSERT
    // to fail (non-existent taskId -> FK violation) alongside a valid task UPDATE,
    // and assert the UPDATE rolled back.
    await db
      .update(tasks)
      .set({ progress: { keyspaceProgress: 111 } })
      .where(eq(tasks.id, seed.taskId))

    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ progress: { keyspaceProgress: 999 } })
          .where(eq(tasks.id, seed.taskId))
        // taskId 2_147_000_000 does not exist -> task_telemetry.task_id FK fails.
        await appendTaskTelemetry(tx, { taskId: 2_147_000_000, agentId: null, keyspaceProgress: 5 })
      })
    ).rejects.toThrow()

    const [row] = await db
      .select({ progress: tasks.progress })
      .from(tasks)
      .where(eq(tasks.id, seed.taskId))
    // The UPDATE to 999 rolled back; progress is still 111.
    expect((row!.progress as { keyspaceProgress: number }).keyspaceProgress).toBe(111)
  })

  it('inserts a telemetry row inside a transaction', async () => {
    await db.transaction(async (tx) => {
      await appendTaskTelemetry(tx, {
        taskId: seed.taskId,
        agentId: seed.agentId,
        keyspaceProgress: 500,
        speedHs: 1_000_000,
        temperature: 72.5,
      })
    })

    const rows = await db
      .select()
      .from(taskTelemetry)
      .where(and(eq(taskTelemetry.taskId, seed.taskId), eq(taskTelemetry.keyspaceProgress, 500n)))

    expect(rows.length).toBe(1)
    expect(rows[0]!.keyspaceProgress).toBe(500n)
    expect(rows[0]!.speedHs).toBe(1_000_000)
    expect(rows[0]!.agentId).toBe(seed.agentId)
    expect(rows[0]!.temperature).toBeCloseTo(72.5, 1)
  })

  it('persists bigint keyspace progress above Number.MAX_SAFE_INTEGER when passed as a string', async () => {
    const bigValue = '9999999999999999'

    await db.transaction(async (tx) => {
      await appendTaskTelemetry(tx, {
        taskId: seed.taskId,
        agentId: seed.agentId,
        keyspaceProgress: bigValue,
        speedHs: null,
        temperature: null,
      })
    })

    const rows = await db
      .select()
      .from(taskTelemetry)
      .where(
        and(
          eq(taskTelemetry.taskId, seed.taskId),
          eq(taskTelemetry.keyspaceProgress, BigInt(bigValue))
        )
      )

    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]!.keyspaceProgress).toBe(BigInt(bigValue))
  })

  it('coerces an invalid keyspace value to 0n', async () => {
    const beforeCount = (
      await db
        .select()
        .from(taskTelemetry)
        .where(and(eq(taskTelemetry.taskId, seed.taskId), eq(taskTelemetry.keyspaceProgress, 0n)))
    ).length

    await db.transaction(async (tx) => {
      await appendTaskTelemetry(tx, {
        taskId: seed.taskId,
        agentId: null,
        keyspaceProgress: 'not-a-number',
        speedHs: null,
        temperature: null,
      })
    })

    const rows = await db
      .select()
      .from(taskTelemetry)
      .where(and(eq(taskTelemetry.taskId, seed.taskId), eq(taskTelemetry.keyspaceProgress, 0n)))

    expect(rows.length).toBe(beforeCount + 1)
    const inserted = rows[rows.length - 1]!
    expect(inserted.keyspaceProgress).toBe(0n)
    expect(inserted.agentId).toBeNull()
  })

  it('rolls back the telemetry row when the transaction is aborted', async () => {
    const beforeCount = (
      await db.select().from(taskTelemetry).where(eq(taskTelemetry.taskId, seed.taskId))
    ).length

    await db
      .transaction(async (tx) => {
        await appendTaskTelemetry(tx, {
          taskId: seed.taskId,
          agentId: seed.agentId,
          keyspaceProgress: 999_999,
          speedHs: null,
          temperature: null,
        })
        tx.rollback()
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || !err.message.includes('Rollback')) throw err
      })

    const afterCount = (
      await db.select().from(taskTelemetry).where(eq(taskTelemetry.taskId, seed.taskId))
    ).length

    expect(afterCount).toBe(beforeCount)
  })
})
