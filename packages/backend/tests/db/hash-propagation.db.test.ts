/**
 * Real-DB tests for U2: propagateCrack — match-by-value propagation primitive.
 *
 * propagateCrack(hashValue, plaintext) fills plaintext + crackedAt onto every
 * uncracked hash item sharing that hash value, across all lists and projects.
 * It does NOT touch username/source/attribution FKs (campaignId/attackId/
 * taskId/agentId) on propagated rows — only uncracked rows are updated, and
 * already-cracked rows are left unchanged (KTD2).
 *
 * Test scenarios:
 * 1. Same hash in list A (project 1) and list B (project 2), both uncracked:
 *    both get plaintext + crackedAt; attribution FKs remain NULL.
 * 2. Already-cracked row left unchanged — both plaintext and crackedAt are
 *    identical to the original seed values (proves KTD2 guard blocks overwrite).
 * 3. No matching rows: returns { updated: 0 }, no error.
 * 4. Integration: hash in a campaign's hash list, once propagated, appears in
 *    getZapsForTask output for that campaign's task.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import { agents, attacks, campaigns, hashItems, hashLists, projects, tasks } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { propagateCrack } from '../../src/services/hash-items/propagation.js'
import { getZapsForTask } from '../../src/services/tasks/zaps.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_A = 'hash-prop-proj-a'
const SLUG_B = 'hash-prop-proj-b'
const SLUG_ZAP = 'hash-prop-proj-zap'

let projAId: number
let listAId: number
let projBId: number
let listBId: number
let zapProjId: number
let zapListId: number
let zapAgentId: number
let zapTaskId: number

// ─── Seed helpers ────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await Promise.all([
    db.delete(projects).where(eq(projects.slug, SLUG_A)),
    db.delete(projects).where(eq(projects.slug, SLUG_B)),
    db.delete(projects).where(eq(projects.slug, SLUG_ZAP)),
  ])
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Defensive cleanup in case a prior run left stale rows.
  await cleanup()

  // Project A + hash list A
  const [pA] = await db
    .insert(projects)
    .values({ name: SLUG_A, slug: SLUG_A })
    .returning({ id: projects.id })
  projAId = pA!.id
  const [lA] = await db
    .insert(hashLists)
    .values({ projectId: projAId, name: 'list-a', status: 'ready' })
    .returning({ id: hashLists.id })
  listAId = lA!.id

  // Project B + hash list B
  const [pB] = await db
    .insert(projects)
    .values({ name: SLUG_B, slug: SLUG_B })
    .returning({ id: projects.id })
  projBId = pB!.id
  const [lB] = await db
    .insert(hashLists)
    .values({ projectId: projBId, name: 'list-b', status: 'ready' })
    .returning({ id: hashLists.id })
  listBId = lB!.id

  // Zap integration project: project → hash list → campaign → attack → agent → task
  const [pZ] = await db
    .insert(projects)
    .values({ name: SLUG_ZAP, slug: SLUG_ZAP })
    .returning({ id: projects.id })
  zapProjId = pZ!.id

  const [lZ] = await db
    .insert(hashLists)
    .values({ projectId: zapProjId, name: 'list-zap', status: 'ready' })
    .returning({ id: hashLists.id })
  zapListId = lZ!.id

  const [camp] = await db
    .insert(campaigns)
    .values({
      name: 'zap-camp',
      projectId: zapProjId,
      hashListId: zapListId,
      priority: 1,
      status: 'running',
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // the attack inserted below (mode 0) — see schema.ts's
      // `attacks_campaign_id_mode_..._fk`.
      hashcatMode: 0,
    })
    .returning({ id: campaigns.id })
  const campId = camp!.id

  const [atk] = await db
    .insert(attacks)
    .values({ campaignId: campId, projectId: zapProjId, mode: 0 })
    .returning({ id: attacks.id })
  const atkId = atk!.id

  const [agnt] = await db
    .insert(agents)
    .values({
      name: 'zap-agent',
      projectId: zapProjId,
      capabilities: { gpu: false },
      status: 'online',
    })
    .returning({ id: agents.id })
  zapAgentId = agnt!.id

  // Insert task with agentId already set; getZapsForTask checks tasks.agentId
  // but no status or lease check, so setting it at insert is sufficient.
  const [task] = await db
    .insert(tasks)
    .values({
      attackId: atkId,
      campaignId: campId,
      agentId: zapAgentId,
      status: 'running',
      workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
      requiredCapabilities: { gpu: false },
    })
    .returning({ id: tasks.id })
  zapTaskId = task!.id
})

afterAll(async () => {
  await cleanup()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('propagateCrack — cross-project propagation', () => {
  it('sets plaintext + crackedAt on uncracked rows in both lists; attribution FKs stay NULL (KTD2)', async () => {
    // Each test uses a distinct hashValue to avoid cross-test pollution.
    const hashValue = 'hash-prop-cross-project-v1'
    const plaintext = 'password123'

    const [rowA] = await db
      .insert(hashItems)
      .values({ hashListId: listAId, hashValue })
      .returning({ id: hashItems.id })
    const [rowB] = await db
      .insert(hashItems)
      .values({ hashListId: listBId, hashValue })
      .returning({ id: hashItems.id })

    try {
      const result = await propagateCrack(hashValue, plaintext)
      expect(result.updated).toBe(2)

      // Verify list A row
      const [updatedA] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          campaignId: hashItems.campaignId,
          attackId: hashItems.attackId,
          taskId: hashItems.taskId,
          agentId: hashItems.agentId,
          username: hashItems.username,
          source: hashItems.source,
        })
        .from(hashItems)
        .where(eq(hashItems.id, rowA!.id))

      expect(updatedA!.plaintext).toBe(plaintext)
      expect(updatedA!.crackedAt).toBeInstanceOf(Date)
      // KTD2: attribution FKs and identity columns must NOT be written
      expect(updatedA!.campaignId).toBeNull()
      expect(updatedA!.attackId).toBeNull()
      expect(updatedA!.taskId).toBeNull()
      expect(updatedA!.agentId).toBeNull()
      expect(updatedA!.username).toBeNull()
      expect(updatedA!.source).toBeNull()

      // Verify list B row
      const [updatedB] = await db
        .select({
          plaintext: hashItems.plaintext,
          crackedAt: hashItems.crackedAt,
          campaignId: hashItems.campaignId,
          attackId: hashItems.attackId,
          taskId: hashItems.taskId,
          agentId: hashItems.agentId,
          username: hashItems.username,
          source: hashItems.source,
        })
        .from(hashItems)
        .where(eq(hashItems.id, rowB!.id))

      expect(updatedB!.plaintext).toBe(plaintext)
      expect(updatedB!.crackedAt).toBeInstanceOf(Date)
      expect(updatedB!.campaignId).toBeNull()
      expect(updatedB!.attackId).toBeNull()
      expect(updatedB!.taskId).toBeNull()
      expect(updatedB!.agentId).toBeNull()
      expect(updatedB!.username).toBeNull()
      expect(updatedB!.source).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, rowA!.id))
      await db.delete(hashItems).where(eq(hashItems.id, rowB!.id))
    }
  })

  it('leaves already-cracked rows unchanged — plaintext, crackedAt, and attribution unmodified (KTD2 guard)', async () => {
    const hashValue = 'hash-prop-idempotent-v1'
    const originalPlaintext = 'original-password'
    const originalCrackedAt = new Date('2024-01-01T00:00:00.000Z')

    // Seed one already-cracked row (simulates a prior agent crack with provenance).
    const [cracked] = await db
      .insert(hashItems)
      .values({
        hashListId: listAId,
        hashValue,
        plaintext: originalPlaintext,
        crackedAt: originalCrackedAt,
      })
      .returning({ id: hashItems.id })

    // Seed one uncracked row in the other list.
    const [uncracked] = await db
      .insert(hashItems)
      .values({ hashListId: listBId, hashValue })
      .returning({ id: hashItems.id })

    try {
      const result = await propagateCrack(hashValue, 'new-password')
      // Only the uncracked row should have been updated.
      expect(result.updated).toBe(1)

      // Already-cracked row: plaintext and crackedAt must be IDENTICAL to original.
      const [afterCracked] = await db
        .select({ plaintext: hashItems.plaintext, crackedAt: hashItems.crackedAt })
        .from(hashItems)
        .where(eq(hashItems.id, cracked!.id))

      expect(afterCracked!.plaintext).toBe(originalPlaintext)
      // Timestamps may differ by milliseconds in round-trip; compare ISO string.
      expect(afterCracked!.crackedAt!.toISOString()).toBe(originalCrackedAt.toISOString())

      // Uncracked row should now carry the propagated plaintext.
      const [afterUncracked] = await db
        .select({ plaintext: hashItems.plaintext, crackedAt: hashItems.crackedAt })
        .from(hashItems)
        .where(eq(hashItems.id, uncracked!.id))

      expect(afterUncracked!.plaintext).toBe('new-password')
      expect(afterUncracked!.crackedAt).toBeInstanceOf(Date)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, cracked!.id))
      await db.delete(hashItems).where(eq(hashItems.id, uncracked!.id))
    }
  })

  it('returns { updated: 0 } when no rows match the hash value', async () => {
    const result = await propagateCrack('hash-prop-no-matches-v1-xxxxxxxx', 'anything')
    expect(result).toStrictEqual({ updated: 0 })
  })
})

describe('propagateCrack — zap integration', () => {
  it('propagated hash appears in getZapsForTask for the campaign hash list', async () => {
    const hashValue = 'hash-prop-zap-integ-v1'

    // Insert the hash UNCRACKED into the campaign's hash list.
    const [item] = await db
      .insert(hashItems)
      .values({ hashListId: zapListId, hashValue })
      .returning({ id: hashItems.id })

    try {
      // Before propagation: hash must NOT appear in zaps.
      const before = await getZapsForTask(zapTaskId, zapAgentId, zapProjId)
      if ('error' in before) {
        throw new Error(`getZapsForTask returned error before propagation: ${before.error}`)
      }
      expect(before.zaps).not.toContain(hashValue)

      // Propagate the crack.
      const { updated } = await propagateCrack(hashValue, 'zap-plaintext')
      expect(updated).toBe(1)

      // After propagation: crackedAt is now set, so zap query picks it up.
      const after = await getZapsForTask(zapTaskId, zapAgentId, zapProjId)
      if ('error' in after) {
        throw new Error(`getZapsForTask returned error after propagation: ${after.error}`)
      }
      expect(after.zaps).toContain(hashValue)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, item!.id))
    }
  })
})
