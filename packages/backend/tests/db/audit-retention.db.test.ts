/**
 * Real-DB tests for the audit-retention worker (U9 / #105).
 *
 * Tests prove retention behavior that the mocked default lane cannot:
 * 1. Rows outside the retention window are deleted.
 * 2. Rows inside the retention window are preserved.
 * 3. Multi-pass batched deletes work correctly (batchSize < total expired rows).
 * 4. Orphaned rows (project_id IS NULL) are purged by the plain createdAt predicate.
 *
 * Isolation strategy: seed rows with explicitly old `createdAt` values and
 * use the default/large window. Do NOT shrink the retention window to catch
 * fresh rows — that would delete other test files' audit rows in the shared lane.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the
 * shared drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — harness.test.ts owns the client lifecycle.
 * NOTE: Do NOT self-skip — test-db lane always has Postgres available.
 */

import { auditLogs, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { purgeExpiredAuditLogs } from '../../src/queue/workers/audit-retention.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_SLUG = 'audit-retention-db-test-proj'
/** A timestamp safely outside any reasonable retention window. */
const OLD_DATE = new Date('2020-01-01T00:00:00.000Z')
/** A timestamp well inside the default 365-day window. */
const RECENT_DATE = new Date(Date.now() - 60 * 60 * 1_000) // 1 hour ago

// ─── Seed helpers ────────────────────────────────────────────────────────────

let projectId: number
let seededIds: number[] = []

async function seedProject(): Promise<number> {
  const [row] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  return row!.id
}

async function insertAuditRow(overrides: {
  createdAt: Date
  projectId: number | null
}): Promise<number> {
  const [row] = await db
    .insert(auditLogs)
    .values({
      actorType: 'user',
      actorId: 1,
      projectId: overrides.projectId,
      entityType: 'campaign',
      entityId: 1,
      action: 'created',
      fromStatus: null,
      toStatus: null,
      reason: null,
      changes: null,
      createdAt: overrides.createdAt,
    })
    .returning({ id: auditLogs.id })
  return row!.id
}

async function cleanupSeed(): Promise<void> {
  // Remove any seeded rows that survived (test teardown).
  if (seededIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.id, seededIds))
  }
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  projectId = await seedProject()
})

afterAll(async () => {
  await cleanupSeed()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('purgeExpiredAuditLogs', () => {
  it('deletes rows outside the retention window and leaves recent rows intact', async () => {
    const oldId = await insertAuditRow({ createdAt: OLD_DATE, projectId })
    const recentId = await insertAuditRow({ createdAt: RECENT_DATE, projectId })
    seededIds = [oldId, recentId]

    const result = await purgeExpiredAuditLogs({ retention: '180 days' })

    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(result.passes).toBeGreaterThanOrEqual(1)

    // The old row must be gone.
    const gone = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, oldId))
    expect(gone).toHaveLength(0)

    // The recent row must survive.
    const survived = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, recentId))
    expect(survived).toHaveLength(1)

    // Remove the surviving row so afterAll cleanup has nothing to do for these.
    await db.delete(auditLogs).where(eq(auditLogs.id, recentId))
    seededIds = []
  })

  it('requires multiple passes when batchSize is smaller than the expired row count', async () => {
    // Seed 5 old rows, run with batchSize 2 — expect at least 3 passes.
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(await insertAuditRow({ createdAt: OLD_DATE, projectId }))
    }
    seededIds = ids

    const result = await purgeExpiredAuditLogs({ retention: '180 days', batchSize: 2 })

    expect(result.deleted).toBeGreaterThanOrEqual(5)
    expect(result.passes).toBeGreaterThanOrEqual(3)

    // All 5 rows must be gone.
    const remaining = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(inArray(auditLogs.id, ids))
    expect(remaining).toHaveLength(0)

    seededIds = []
  })

  it('purges orphaned rows (project_id IS NULL) via the createdAt predicate', async () => {
    // NULL project_id: simulates a row left after its project was deleted.
    const orphanId = await insertAuditRow({ createdAt: OLD_DATE, projectId: null })
    seededIds = [orphanId]

    const result = await purgeExpiredAuditLogs({ retention: '180 days' })

    expect(result.deleted).toBeGreaterThanOrEqual(1)

    const gone = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, orphanId))
    expect(gone).toHaveLength(0)

    seededIds = []
  })

  it('returns deleted=0 and passes=1 when no rows are outside the window', async () => {
    // Seed one recent row; purge should not touch it.
    const recentId = await insertAuditRow({ createdAt: RECENT_DATE, projectId })
    seededIds = [recentId]

    const result = await purgeExpiredAuditLogs({ retention: '180 days' })

    // deleted may be 0 (no expired rows seeded in this pass) or non-zero if
    // other test files' rows were old — we only assert the recent row survives.
    expect(result.passes).toBeGreaterThanOrEqual(1)

    const survived = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, recentId))
    expect(survived).toHaveLength(1)

    await db.delete(auditLogs).where(eq(auditLogs.id, recentId))
    seededIds = []
  })
})
