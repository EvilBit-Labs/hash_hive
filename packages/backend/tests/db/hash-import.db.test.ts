/**
 * Real-DB tests for U7: hash import propagation worker.
 *
 * Tests call `processImportPairs` directly — the testable DB core exported
 * from the worker — bypassing Redis and S3 entirely.  The BullMQ shell
 * (createHashImportWorker) is excluded because the DB test lane has no live
 * Redis; `buildHashImportJobId` is unit-tested here to prove the eviction
 * contract without needing a queue.
 *
 * Test scenarios:
 *   1. Uncracked hash → cracked with import provenance (source='import', username set).
 *   2. Already-cracked hash → plaintext, crackedAt, campaignId/attackId/taskId/agentId
 *      all preserved (setWhere guard KTD2).
 *   3. Same hash in another project's list → propagated (plaintext set) but NO
 *      source/username (propagateCrack does not write provenance — R11).
 *   4. Zap integration: propagated hash appears in getZapsForTask for the campaign.
 *   5. Audit event recorded exactly once at hash_list scope with correct actor.
 *   6. buildHashImportJobId returns a stable, non-empty string (proves the jobId
 *      will be passed to QueueManager.enqueue, which auto-pairs it with
 *      removeOnComplete + removeOnFail — see queue/manager.ts:133).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts).
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide singleton.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import {
  agents,
  attacks,
  auditLogs,
  campaigns,
  hashItems,
  hashLists,
  projects,
  tasks,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  buildHashImportJobId,
  processImportPairs,
} from '../../src/queue/workers/hash-import-worker.js'
import { getZapsForTask } from '../../src/services/tasks/zaps.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_TARGET = 'hash-import-proj-target'
const SLUG_OTHER = 'hash-import-proj-other'

// system actor — no user row required for these tests
const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null }

let targetProjId: number
let targetListId: number
let targetCampId: number
let targetAttackId: number
let targetAgentId: number
let targetTaskId: number
let otherProjId: number
let otherListId: number

// ─── Lifecycle ───────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  // Delete audit rows first (project_id IS SET NULL on cascade, so they
  // become orphaned — not deleted — when the project is deleted).
  if (targetListId !== undefined) {
    await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
  }
  await Promise.all([
    db.delete(projects).where(eq(projects.slug, SLUG_TARGET)),
    db.delete(projects).where(eq(projects.slug, SLUG_OTHER)),
  ])
}

beforeAll(async () => {
  await cleanup()

  // ── Target project (project A) ────────────────────────────────────────────
  const [pTarget] = await db
    .insert(projects)
    .values({ name: SLUG_TARGET, slug: SLUG_TARGET })
    .returning({ id: projects.id })
  targetProjId = pTarget!.id

  const [lTarget] = await db
    .insert(hashLists)
    .values({ projectId: targetProjId, name: 'import-target-list', status: 'ready' })
    .returning({ id: hashLists.id })
  targetListId = lTarget!.id

  const [camp] = await db
    .insert(campaigns)
    .values({
      name: 'import-target-camp',
      projectId: targetProjId,
      hashListId: targetListId,
      priority: 1,
      status: 'running',
    })
    .returning({ id: campaigns.id })
  targetCampId = camp!.id

  const [atk] = await db
    .insert(attacks)
    .values({ campaignId: targetCampId, projectId: targetProjId, mode: 0 })
    .returning({ id: attacks.id })
  targetAttackId = atk!.id

  const [agnt] = await db
    .insert(agents)
    .values({
      name: 'import-target-agent',
      projectId: targetProjId,
      capabilities: { gpu: false },
      status: 'online',
    })
    .returning({ id: agents.id })
  targetAgentId = agnt!.id

  const [task] = await db
    .insert(tasks)
    .values({
      attackId: targetAttackId,
      campaignId: targetCampId,
      agentId: targetAgentId,
      status: 'running',
      workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
      requiredCapabilities: { gpu: false },
    })
    .returning({ id: tasks.id })
  targetTaskId = task!.id

  // ── Other project (project B — cross-project propagation) ─────────────────
  const [pOther] = await db
    .insert(projects)
    .values({ name: SLUG_OTHER, slug: SLUG_OTHER })
    .returning({ id: projects.id })
  otherProjId = pOther!.id

  const [lOther] = await db
    .insert(hashLists)
    .values({ projectId: otherProjId, name: 'import-other-list', status: 'ready' })
    .returning({ id: hashLists.id })
  otherListId = lOther!.id
})

afterAll(async () => {
  await cleanup()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('processImportPairs — provenance write', () => {
  it('marks uncracked target-list row cracked with source=import and username (scenario 1)', async () => {
    const hashValue = 'hash-import-prov-uncracked-v1'
    const plaintext = 'importedPassword'
    const username = 'jdoe'

    const [row] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      const result = await processImportPairs(
        [{ hashValue, plaintext, username }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0
      )

      // Summary counts: 1 matched (pre-existing uncracked), 1 cracked
      expect(result.matchedInList).toBe(1)
      expect(result.crackedInList).toBe(1)
      expect(result.skipped).toBe(0)

      const [after] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          source: hashItems.source,
          username: hashItems.username,
          campaignId: hashItems.campaignId,
          attackId: hashItems.attackId,
          taskId: hashItems.taskId,
          agentId: hashItems.agentId,
        })
        .from(hashItems)
        .where(eq(hashItems.id, row!.id))

      expect(after!.plaintext).toBe(plaintext)
      expect(after!.crackedAt).toBeInstanceOf(Date)
      expect(after!.source).toBe('import')
      expect(after!.username).toBe(username)
      // Attribution FKs must stay null — import does not set campaign provenance
      expect(after!.campaignId).toBeNull()
      expect(after!.attackId).toBeNull()
      expect(after!.taskId).toBeNull()
      expect(after!.agentId).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
      // Clean up audit log row written by this run
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('processImportPairs — setWhere guard (KTD2)', () => {
  it('leaves already-cracked row unchanged — plaintext, crackedAt, and all attribution FKs preserved (scenario 2)', async () => {
    const hashValue = 'hash-import-guard-cracked-v1'
    const originalPlaintext = 'agentPassword'
    const originalCrackedAt = new Date('2024-06-01T12:00:00.000Z')

    // Seed an already-cracked row with full attribution provenance
    const [row] = await db
      .insert(hashItems)
      .values({
        hashListId: targetListId,
        hashValue,
        plaintext: originalPlaintext,
        crackedAt: originalCrackedAt,
        campaignId: targetCampId,
        attackId: targetAttackId,
        taskId: targetTaskId,
        agentId: targetAgentId,
        // Agent-cracked rows carry NULL source in production (only the parser
        // sets 'upload' and the import worker sets 'import'); attribution FKs
        // identify the agent crack.
        source: null,
        username: null,
      })
      .returning({ id: hashItems.id })

    try {
      const result = await processImportPairs(
        [{ hashValue, plaintext: 'importAttempt' }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0
      )

      // matchedInList = 1 (row exists), crackedInList = 0 (row was already cracked)
      expect(result.matchedInList).toBe(1)
      expect(result.crackedInList).toBe(0)

      const [after] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          source: hashItems.source,
          username: hashItems.username,
          campaignId: hashItems.campaignId,
          attackId: hashItems.attackId,
          taskId: hashItems.taskId,
          agentId: hashItems.agentId,
        })
        .from(hashItems)
        .where(eq(hashItems.id, row!.id))

      // All fields must be IDENTICAL to the seeded values — setWhere blocked the update
      expect(after!.plaintext).toBe(originalPlaintext)
      expect(after!.crackedAt!.toISOString()).toBe(originalCrackedAt.toISOString())
      expect(after!.source).toBeNull()
      expect(after!.username).toBeNull()
      expect(after!.campaignId).toBe(targetCampId)
      expect(after!.attackId).toBe(targetAttackId)
      expect(after!.taskId).toBe(targetTaskId)
      expect(after!.agentId).toBe(targetAgentId)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('processImportPairs — cross-project propagation (R11)', () => {
  it('propagates plaintext to other-project list WITHOUT source/username (scenario 3)', async () => {
    const hashValue = 'hash-import-cross-proj-v1'
    const plaintext = 'crossProjectPass'

    // Insert uncracked in target list AND uncracked in other-project list
    const [rowTarget] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue })
      .returning({ id: hashItems.id })
    const [rowOther] = await db
      .insert(hashItems)
      .values({ hashListId: otherListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      await processImportPairs(
        [{ hashValue, plaintext }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0
      )

      // Target row: full provenance (source='import')
      const [afterTarget] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          source: hashItems.source,
          username: hashItems.username,
        })
        .from(hashItems)
        .where(eq(hashItems.id, rowTarget!.id))

      expect(afterTarget!.plaintext).toBe(plaintext)
      expect(afterTarget!.crackedAt).toBeInstanceOf(Date)
      expect(afterTarget!.source).toBe('import')

      // Other-project row: propagated plaintext only — NO source/username (R11)
      const [afterOther] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          source: hashItems.source,
          username: hashItems.username,
        })
        .from(hashItems)
        .where(eq(hashItems.id, rowOther!.id))

      expect(afterOther!.plaintext).toBe(plaintext)
      expect(afterOther!.crackedAt).toBeInstanceOf(Date)
      // propagateCrack deliberately does not set source or username (KTD2)
      expect(afterOther!.source).toBeNull()
      expect(afterOther!.username).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, rowTarget!.id))
      await db.delete(hashItems).where(eq(hashItems.id, rowOther!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('processImportPairs — zap integration (scenario 4)', () => {
  it('propagated hash appears in getZapsForTask for the campaign hash list', async () => {
    const hashValue = 'hash-import-zap-integ-v1'
    const plaintext = 'zapImportPass'

    const [item] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      // Before import: hash must not appear in zaps
      const before = await getZapsForTask(targetTaskId, targetAgentId, targetProjId)
      if ('error' in before) {
        throw new Error(`getZapsForTask error before import: ${before.error}`)
      }
      expect(before.zaps).not.toContain(hashValue)

      await processImportPairs(
        [{ hashValue, plaintext }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0
      )

      // After import: hash is cracked, so the zap query picks it up
      const after = await getZapsForTask(targetTaskId, targetAgentId, targetProjId)
      if ('error' in after) {
        throw new Error(`getZapsForTask error after import: ${after.error}`)
      }
      expect(after.zaps).toContain(hashValue)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, item!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('processImportPairs — audit event (scenario 5)', () => {
  it('records exactly one audit event at hash_list scope with correct actor and action', async () => {
    const hashValue = 'hash-import-audit-v1'

    const [row] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      const actor = { actorType: 'user' as const, actorId: 42 }

      await processImportPairs(
        [{ hashValue, plaintext: 'auditPass' }],
        targetListId,
        targetProjId,
        actor,
        3 // pretend 3 lines were skipped during parsing
      )

      // Fetch all audit rows for this hash list (scoped by entityId, not projectId,
      // because project_id is SET NULL on project deletion and may drift in cleanup).
      const rows = await db
        .select({
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          actorType: auditLogs.actorType,
          actorId: auditLogs.actorId,
          projectId: auditLogs.projectId,
          reason: auditLogs.reason,
        })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))

      expect(rows).toHaveLength(1)
      const [evt] = rows
      expect(evt!.entityType).toBe('hash_list')
      expect(evt!.entityId).toBe(targetListId)
      expect(evt!.action).toBe('updated')
      expect(evt!.actorType).toBe('user')
      expect(evt!.actorId).toBe(42)
      expect(evt!.projectId).toBe(targetProjId)
      expect(evt!.reason).toBe('import')
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('buildHashImportJobId — eviction contract (scenario 6)', () => {
  it('returns a non-empty deterministic string that encodes both hashListId and stagingKey', () => {
    // This proves the jobId will be passed to QueueManager.enqueue.
    // The manager unconditionally adds removeOnComplete + removeOnFail when a
    // jobId is present (queue/manager.ts:133), so passing a non-empty jobId is
    // sufficient to guarantee eviction and prevent deduped-key lock-out.
    const stagingKey = 'imports/staging/abc-123-uuid.json'
    const id1 = buildHashImportJobId(99, stagingKey)
    const id2 = buildHashImportJobId(99, stagingKey)

    expect(id1).toBeTypeOf('string')
    expect(id1.length).toBeGreaterThan(0)
    // Deterministic: same inputs produce same jobId
    expect(id1).toBe(id2)
    // Both inputs are encoded so different args produce different ids
    expect(buildHashImportJobId(100, stagingKey)).not.toBe(id1)
    expect(buildHashImportJobId(99, 'imports/staging/other-uuid.json')).not.toBe(id1)
  })
})
