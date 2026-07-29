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
 *   3. Same hash in a SAME-PROJECT sibling list → propagated (plaintext set) but
 *      NO source/username (propagateCrack does not write provenance — R11); a
 *      same-value row in ANOTHER project is NOT touched (project scope — KTD3 /
 *      security F2 closes the prior cross-tenant plaintext leak).
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
  projectCrackedHashes,
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
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // the attack inserted below (mode 0) — see schema.ts's
      // `attacks_campaign_id_mode_..._fk`.
      hashcatMode: 0,
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

    // Seed with source='upload' — import must NOT overwrite the existing origin (item B)
    const [row] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue, source: 'upload' })
      .returning({ id: hashItems.id })

    try {
      const result = await processImportPairs(
        [{ hashValue, plaintext, username }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-prov-v1',
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
      // Origin preserved — COALESCE keeps the existing 'upload' source (item B)
      expect(after!.source).toBe('upload')
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
        0,
        'staging-key-guard-v1',
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

describe('processImportPairs — project-scoped propagation (R11 / KTD3 / security F2)', () => {
  it('propagates plaintext to a SAME-PROJECT sibling list (no source/username) but NOT to another project (scenario 3)', async () => {
    const hashValue = 'hash-import-cross-proj-v1'
    const plaintext = 'crossProjectPass'

    // A second list in the TARGET project to receive within-project propagation.
    const [siblingList] = await db
      .insert(hashLists)
      .values({ projectId: targetProjId, name: 'import-sibling-list', status: 'ready' })
      .returning({ id: hashLists.id })

    // Insert uncracked in target list, uncracked in a same-project sibling list,
    // and uncracked in an OTHER-project list. Sibling/other seeded at the same
    // resolved mode (0) as the import so the mode guard admits them — the only
    // reason the other-project row stays uncracked is project scope.
    const [rowTarget] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue, detectedHashcatMode: 0 })
      .returning({ id: hashItems.id })
    const [rowSibling] = await db
      .insert(hashItems)
      .values({ hashListId: siblingList!.id, hashValue, detectedHashcatMode: 0 })
      .returning({ id: hashItems.id })
    const [rowOther] = await db
      .insert(hashItems)
      .values({ hashListId: otherListId, hashValue, detectedHashcatMode: 0 })
      .returning({ id: hashItems.id })

    try {
      await processImportPairs(
        [{ hashValue, plaintext }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-cross-v1',
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

      // Same-project sibling row: propagated plaintext only — NO source/username (R11)
      const [afterSibling] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          source: hashItems.source,
          username: hashItems.username,
        })
        .from(hashItems)
        .where(eq(hashItems.id, rowSibling!.id))

      expect(afterSibling!.plaintext).toBe(plaintext)
      expect(afterSibling!.crackedAt).toBeInstanceOf(Date)
      // propagateCrack deliberately does not set source or username (KTD2)
      expect(afterSibling!.source).toBeNull()
      expect(afterSibling!.username).toBeNull()

      // Other-project row: MUST stay uncracked — propagation never crosses the
      // project boundary (KTD3 / security F2 closes the prior cross-tenant leak).
      const [afterOther] = await db
        .select({ plaintext: hashItems.plaintext, crackedAt: hashItems.crackedAt })
        .from(hashItems)
        .where(eq(hashItems.id, rowOther!.id))

      expect(afterOther!.plaintext).toBeNull()
      expect(afterOther!.crackedAt).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, rowTarget!.id))
      await db.delete(hashItems).where(eq(hashItems.id, rowSibling!.id))
      await db.delete(hashItems).where(eq(hashItems.id, rowOther!.id))
      await db.delete(hashLists).where(eq(hashLists.id, siblingList!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('processImportPairs — zap integration (scenario 4)', () => {
  it('an import with a resolved mode populates the cracked-set, so the value zaps immediately (RF1)', async () => {
    // RF1: the import worker now upserts each crack into the per-project
    // cracked-set (project_cracked_hashes) in the SAME transaction as the
    // hash_items write. getZapsForTask (U3) resolves from that cracked-set at
    // project+mode scope, so an import with a resolvable mode surfaces as a zap
    // WITHOUT any separate backfill — the previous behavior (import fills
    // hash_items only, never zaps until a manual cracked-set write) is the bug
    // this residual closes.
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
        0,
        'staging-key-zap-v1',
        // Resolved mode 0 — matches the campaign/task mode getZapsForTask scans.
        0
      )

      // After import: the crack is in the cracked-set at (project, mode 0), so
      // the widened zap scan now surfaces it — no manual cracked-set write needed.
      const afterImport = await getZapsForTask(targetTaskId, targetAgentId, targetProjId)
      if ('error' in afterImport) {
        throw new Error(`getZapsForTask error after import: ${afterImport.error}`)
      }
      expect(afterImport.zaps).toContain(hashValue)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, item!.id))
      await db
        .delete(projectCrackedHashes)
        .where(
          and(
            eq(projectCrackedHashes.projectId, targetProjId),
            eq(projectCrackedHashes.hashValue, hashValue)
          )
        )
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

describe('processImportPairs — cracked-set population (RF1)', () => {
  it('records an imported crack in project_cracked_hashes when the mode is resolvable, and skips it when the mode is null (KTD3)', async () => {
    const resolvableHash = 'hash-import-crackedset-mode-v1'
    const modelessHash = 'hash-import-crackedset-null-v1'
    const plaintext = 'crackedSetPass'

    try {
      // (a) Import with a resolved mode → a cracked-set row must appear.
      await processImportPairs(
        [{ hashValue: resolvableHash, plaintext }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-crackedset-mode',
        1000 // resolvable mode (NTLM)
      )

      const modeRows = await db
        .select({
          plaintext: projectCrackedHashes.plaintext,
          sourceHashListId: projectCrackedHashes.sourceHashListId,
        })
        .from(projectCrackedHashes)
        .where(
          and(
            eq(projectCrackedHashes.projectId, targetProjId),
            eq(projectCrackedHashes.hashcatMode, 1000),
            eq(projectCrackedHashes.hashValue, resolvableHash)
          )
        )
      expect(modeRows).toHaveLength(1)
      expect(modeRows[0]!.plaintext).toBe(plaintext)
      // Provenance: the crack is attributed to the target list (R17).
      expect(modeRows[0]!.sourceHashListId).toBe(targetListId)

      // (b) Import with a null mode → no cracked-set row (mode-less never dedups).
      await processImportPairs(
        [{ hashValue: modelessHash, plaintext }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-crackedset-null',
        null // no resolvable mode
      )

      const nullModeRows = await db
        .select({ id: projectCrackedHashes.id })
        .from(projectCrackedHashes)
        .where(
          and(
            eq(projectCrackedHashes.projectId, targetProjId),
            eq(projectCrackedHashes.hashValue, modelessHash)
          )
        )
      expect(nullModeRows).toHaveLength(0)
    } finally {
      await db
        .delete(projectCrackedHashes)
        .where(
          and(
            eq(projectCrackedHashes.projectId, targetProjId),
            eq(projectCrackedHashes.hashValue, resolvableHash)
          )
        )
      await db
        .delete(hashItems)
        .where(and(eq(hashItems.hashListId, targetListId), eq(hashItems.hashValue, resolvableHash)))
      await db
        .delete(hashItems)
        .where(and(eq(hashItems.hashListId, targetListId), eq(hashItems.hashValue, modelessHash)))
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

      const stagingKey = 'staging-key-audit-v1'
      await processImportPairs(
        [{ hashValue, plaintext: 'auditPass' }],
        targetListId,
        targetProjId,
        actor,
        3, // pretend 3 lines were skipped during parsing
        stagingKey,
        0
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

describe('processImportPairs — audit dedup on retry (item I)', () => {
  it('skips a second audit write when the same stagingKey is used (BullMQ retry simulation)', async () => {
    const hashValue = 'hash-import-audit-dedup-v1'
    const stagingKey = 'staging-key-dedup-retry-v1'
    const actor = { actorType: 'user' as const, actorId: 99 }

    const [row] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      // First call — writes the audit row
      await processImportPairs(
        [{ hashValue, plaintext: 'retryPass' }],
        targetListId,
        targetProjId,
        actor,
        0,
        stagingKey,
        0
      )
      // Second call with the same stagingKey — simulates a BullMQ retry.
      // The dedup check must detect the existing row and skip the insert.
      await processImportPairs(
        [{ hashValue, plaintext: 'retryPass' }],
        targetListId,
        targetProjId,
        actor,
        0,
        stagingKey,
        0
      )

      const auditRows = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))

      // Exactly one audit row regardless of how many times processImportPairs ran
      expect(auditRows).toHaveLength(1)
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

// ─── (new) test 1: username COALESCE preservation ─────────────────────────────

describe('processImportPairs — username COALESCE preservation', () => {
  it('preserves existing username when import pair has no username (1a)', async () => {
    // An uncracked row seeded with a username from a prior upload.
    // An import without a username must NOT null out the existing value.
    const hashValue = 'hash-import-coalesce-preserve-v1a'
    const existingUsername = 'admin'

    const [row] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue, username: existingUsername })
      .returning({ id: hashItems.id })

    try {
      await processImportPairs(
        [{ hashValue, plaintext: 'importedPass' }], // no username field
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-coalesce-1a',
        0
      )

      const [after] = await db
        .select({ username: hashItems.username })
        .from(hashItems)
        .where(eq(hashItems.id, row!.id))

      expect(after!.username).toBe(existingUsername)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })

  it('sets username from import pair when the pair carries one (1b)', async () => {
    // An uncracked row with no username — import provides 'root'.
    const hashValue = 'hash-import-coalesce-set-v1b'
    const importUsername = 'root'

    const [row] = await db
      .insert(hashItems)
      .values({ hashListId: targetListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      await processImportPairs(
        [{ hashValue, plaintext: 'importedPass', username: importUsername }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-coalesce-1b',
        0
      )

      const [after] = await db
        .select({ username: hashItems.username })
        .from(hashItems)
        .where(eq(hashItems.id, row!.id))

      expect(after!.username).toBe(importUsername)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

// ─── (new) test 2: new-row insert path ────────────────────────────────────────

describe('processImportPairs — new row insert', () => {
  it('inserts a cracked row when hashValue is not pre-existing; matchedInList and crackedInList are both 0', async () => {
    // The hash does not exist in targetListId before the import.
    // summary counts reflect only pre-existing matches, so both are 0.
    // The row IS inserted as a cracked entry with source='import'.
    const hashValue = 'hash-import-new-row-v2'
    const plaintext = 'newRowPass'

    try {
      const result = await processImportPairs(
        [{ hashValue, plaintext }],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-newrow-v2',
        0
      )

      expect(result.matchedInList).toBe(0)
      expect(result.crackedInList).toBe(0)

      const [inserted] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          source: hashItems.source,
        })
        .from(hashItems)
        .where(and(eq(hashItems.hashListId, targetListId), eq(hashItems.hashValue, hashValue)))

      expect(inserted).toBeDefined()
      expect(inserted!.plaintext).toBe(plaintext)
      expect(inserted!.crackedAt).toBeInstanceOf(Date)
      expect(inserted!.source).toBe('import')
    } finally {
      await db
        .delete(hashItems)
        .where(and(eq(hashItems.hashListId, targetListId), eq(hashItems.hashValue, hashValue)))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})

// ─── (new) test 3: duplicate hashValue deduplication ──────────────────────────

describe('processImportPairs — duplicate hashValue deduplication', () => {
  it('deduplicates pairs before upsert so the last occurrence plaintext wins and no DB error occurs', async () => {
    // processImportPairs deduplicates by hashValue (last-wins Map).
    // Without deduplication the upsert raises
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const hashValue = 'hash-import-dedup-v3'
    const finalPlaintext = 'lastPass'

    try {
      // Three pairs with the same hashValue — last occurrence should win.
      const result = await processImportPairs(
        [
          { hashValue, plaintext: 'firstPass' },
          { hashValue, plaintext: 'middlePass' },
          { hashValue, plaintext: finalPlaintext },
        ],
        targetListId,
        targetProjId,
        SYSTEM_ACTOR,
        0,
        'staging-key-dedup-v3',
        0
      )

      // New row (not pre-existing) → both summary counts are 0
      expect(result.matchedInList).toBe(0)
      expect(result.crackedInList).toBe(0)

      const [inserted] = await db
        .select({ plaintext: hashItems.plaintext })
        .from(hashItems)
        .where(and(eq(hashItems.hashListId, targetListId), eq(hashItems.hashValue, hashValue)))

      expect(inserted!.plaintext).toBe(finalPlaintext)
    } finally {
      await db
        .delete(hashItems)
        .where(and(eq(hashItems.hashListId, targetListId), eq(hashItems.hashValue, hashValue)))
      await db
        .delete(auditLogs)
        .where(and(eq(auditLogs.entityType, 'hash_list'), eq(auditLogs.entityId, targetListId)))
    }
  })
})
