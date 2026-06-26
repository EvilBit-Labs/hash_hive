/**
 * Real-DB tests for the audit_logs table (U1 / #105).
 *
 * Tests prove SQL-level behavior that the mocked default lane cannot:
 * 1. Out-of-vocabulary values are rejected by CHECK constraints.
 * 2. Rows with a deleted project retain data but project_id becomes NULL
 *    (ON DELETE SET NULL FK), so no orphaned data is silently lost.
 * 3. The nominal insert round-trips all columns correctly.
 * 4. Vocab drift guard: every Zod enum value appears in the actual DB
 *    CHECK constraint definition (via pg_constraint catalog), so a
 *    mismatch between the const array and the hardcoded SQL literal is
 *    caught at test time.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the
 * shared drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — harness.test.ts owns the client lifecycle.
 * NOTE: Do NOT self-skip — test-db lane always has Postgres available.
 */

import {
  AUDIT_ACTION_VALUES,
  AUDIT_ACTOR_TYPE_VALUES,
  AUDIT_ENTITY_TYPE_VALUES,
  auditLogs,
  projects,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

const TEST_SLUG = 'audit-logs-db-test-proj'

// ─── Seed helpers ───────────────────────────────────────────────────────────

let projectId: number

async function seedProject(): Promise<number> {
  const [row] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  return row!.id
}

async function cleanupSeed(): Promise<void> {
  // Delete this file's audit rows FIRST (by projectId), then the project.
  // Deleting the project first would set project_id NULL on those rows,
  // and a blanket NULL sweep would be a footgun for other db test files.
  await db.delete(auditLogs).where(eq(auditLogs.projectId, projectId))
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

// ─── Test lifecycle ─────────────────────────────────────────────────────────

beforeAll(async () => {
  projectId = await seedProject()
})

afterAll(async () => {
  await cleanupSeed()
})

// ─── Nominal insert ──────────────────────────────────────────────────────────

describe('audit_logs nominal insert', () => {
  it('persists a well-formed row and returns the same values', async () => {
    const [row] = await db
      .insert(auditLogs)
      .values({
        actorType: 'user',
        actorId: 1,
        projectId,
        entityType: 'campaign',
        entityId: 42,
        action: 'created',
        fromStatus: null,
        toStatus: 'pending',
        reason: null,
        changes: { before: null, after: { name: 'Demo' } },
      })
      .returning()

    expect(row).toBeDefined()
    expect(row!.actorType).toBe('user')
    expect(row!.actorId).toBe(1)
    expect(row!.projectId).toBe(projectId)
    expect(row!.entityType).toBe('campaign')
    expect(row!.entityId).toBe(42)
    expect(row!.action).toBe('created')
    expect(row!.toStatus).toBe('pending')
    expect(row!.changes).toEqual({ before: null, after: { name: 'Demo' } })
    expect(row!.createdAt).toBeInstanceOf(Date)
  })

  it('allows actorId to be null (system actor)', async () => {
    const [row] = await db
      .insert(auditLogs)
      .values({
        actorType: 'system',
        actorId: null,
        projectId,
        entityType: 'project',
        entityId: projectId,
        action: 'status_changed',
      })
      .returning({ id: auditLogs.id, actorId: auditLogs.actorId })

    expect(row!.actorId).toBeNull()
  })
})

// ─── CHECK constraint rejection ─────────────────────────────────────────────

describe('audit_logs CHECK constraints', () => {
  it('rejects an out-of-vocabulary actor_type', async () => {
    await expect(
      (async () =>
        db.execute(
          sql`INSERT INTO audit_logs (actor_type, entity_type, entity_id, action)
              VALUES ('robot', 'campaign', 1, 'created')`
        ))()
    ).rejects.toThrow()
  })

  it('rejects an out-of-vocabulary entity_type', async () => {
    await expect(
      (async () =>
        db.execute(
          sql`INSERT INTO audit_logs (actor_type, entity_type, entity_id, action)
              VALUES ('user', 'unknown_resource', 1, 'created')`
        ))()
    ).rejects.toThrow()
  })

  it('rejects an out-of-vocabulary action', async () => {
    await expect(
      (async () =>
        db.execute(
          sql`INSERT INTO audit_logs (actor_type, entity_type, entity_id, action)
              VALUES ('user', 'campaign', 1, 'exploded')`
        ))()
    ).rejects.toThrow()
  })
})

// ─── Vocab drift guard (pg_constraint catalog) ──────────────────────────────
//
// Postgres rewrites `IN ('a', 'b')` to `= ANY (ARRAY['a', 'b'])` in the
// constraint definition stored in pg_constraint.  We therefore assert by
// substring ('user'::text) rather than exact form.  If any vocab item is
// missing from the Drizzle-generated CHECK literal, this test will catch it.

describe('audit_logs vocab drift — DB CHECK vs const arrays', () => {
  type ConstraintRow = { conname: string; condef: string }

  async function getCheckDefs(): Promise<Record<string, string>> {
    const rows = await db.execute<ConstraintRow>(
      sql`
        SELECT conname, pg_get_constraintdef(oid) AS condef
        FROM   pg_constraint
        WHERE  conrelid = 'audit_logs'::regclass
          AND  contype  = 'c'
      `
    )
    const map: Record<string, string> = {}
    for (const r of rows) {
      map[r.conname] = r.condef
    }
    return map
  }

  it('every AUDIT_ACTOR_TYPE_VALUES value appears in audit_logs_actor_type_chk', async () => {
    const defs = await getCheckDefs()
    const def = defs['audit_logs_actor_type_chk']
    expect(def).toBeDefined()
    for (const v of AUDIT_ACTOR_TYPE_VALUES) {
      expect(def).toContain(`'${v}'`)
    }
  })

  it('every AUDIT_ENTITY_TYPE_VALUES value appears in audit_logs_entity_type_chk', async () => {
    const defs = await getCheckDefs()
    const def = defs['audit_logs_entity_type_chk']
    expect(def).toBeDefined()
    for (const v of AUDIT_ENTITY_TYPE_VALUES) {
      expect(def).toContain(`'${v}'`)
    }
  })

  it('every AUDIT_ACTION_VALUES value appears in audit_logs_action_chk', async () => {
    const defs = await getCheckDefs()
    const def = defs['audit_logs_action_chk']
    expect(def).toBeDefined()
    for (const v of AUDIT_ACTION_VALUES) {
      expect(def).toContain(`'${v}'`)
    }
  })
})

// ─── ON DELETE SET NULL (project FK) ────────────────────────────────────────

describe('audit_logs project FK — ON DELETE SET NULL', () => {
  it('sets project_id to null when the referenced project is deleted', async () => {
    // Seed a disposable project and write an audit row for it.
    const tempSlug = 'audit-logs-fk-delete-test'
    const [tempProj] = await db
      .insert(projects)
      .values({ name: tempSlug, slug: tempSlug })
      .returning({ id: projects.id })

    const tempProjectId = tempProj!.id

    const [logRow] = await db
      .insert(auditLogs)
      .values({
        actorType: 'user',
        actorId: 1,
        projectId: tempProjectId,
        entityType: 'project',
        entityId: tempProjectId,
        action: 'created',
      })
      .returning({ id: auditLogs.id })

    const logId = logRow!.id

    // Delete the project — FK is ON DELETE SET NULL.
    await db.delete(projects).where(eq(projects.id, tempProjectId))

    // The audit row must still exist with project_id = NULL.
    const [orphan] = await db
      .select({ id: auditLogs.id, projectId: auditLogs.projectId })
      .from(auditLogs)
      .where(eq(auditLogs.id, logId))

    expect(orphan).toBeDefined()
    expect(orphan!.projectId).toBeNull()

    // Clean up the orphaned row.
    await db.delete(auditLogs).where(eq(auditLogs.id, logId))
  })
})
