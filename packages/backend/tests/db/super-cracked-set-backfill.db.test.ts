/**
 * Real-DB test for migration 0044 — one-time cracked-set backfill + safe repair
 * (issue #101). Executes the ACTUAL migration SQL against seeded scenarios so
 * the file and its guarantees stay in lock-step.
 *
 * Verifies:
 *   - REPAIR: a no-attribution `propagateCrack`-style fill whose (project, mode,
 *     value) is contradicted by an authoritative attribution-backed crack is
 *     corrected to the real plaintext.
 *   - SAFETY: a no-attribution fill with NO attributed backing is left untouched
 *     (its correctness is undecidable from data — never nulled/guessed); a
 *     legitimate precracked import (source='import', no attribution) is never
 *     corrupted.
 *   - BACKFILL: every cracked row with a resolved mode lands in the cracked-set,
 *     deduped per (project, mode, value), preferring the attributed plaintext,
 *     with cracked_at stamped NOW (>= historical) and original_cracked_at
 *     preserving the historical crack (KTD2). Idempotent (re-run is a no-op).
 *
 * NOTE: Do NOT call client.end(). Do NOT self-skip.
 */

import { campaigns, hashItems, hashLists, projectCrackedHashes, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { db } from '../../src/db/index.js'

const SLUG = 'super-cracked-set-backfill-proj'
const MODE_A = 9_614_000
const MODE_B = 9_614_001

let projId = 0
let listId = 0
let campaignId = 0
let seq = 0

const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../../shared/src/db/migrations/0044_super_cracked_set_backfill_quarantine.sql',
    import.meta.url
  )
)

async function runMigration(): Promise<void> {
  const raw = readFileSync(MIGRATION_PATH, 'utf8')
  // Strip comments, split on drizzle's statement breakpoint, run each.
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0)
  for (const statement of statements) {
    await db.execute(sql.raw(statement))
  }
}

async function insertItem(
  hashValue: string,
  opts: {
    mode?: number | null
    plaintext?: string | null
    crackedAt?: Date | null
    attributed?: boolean
    source?: string | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(hashItems)
    .values({
      hashListId: listId,
      hashValue,
      detectedHashcatMode: opts.mode === undefined ? MODE_A : opts.mode,
      plaintext: opts.plaintext ?? null,
      crackedAt: opts.crackedAt ?? null,
      // Attribution present ⇒ an agent-recorded crack; absent ⇒ a fill.
      campaignId: opts.attributed ? campaignId : null,
      source: opts.source ?? null,
    })
    .returning({ id: hashItems.id })
  return row!.id
}

async function itemPlaintext(id: number): Promise<string | null> {
  const [row] = await db
    .select({ p: hashItems.plaintext })
    .from(hashItems)
    .where(eq(hashItems.id, id))
  return row?.p ?? null
}

async function crackedSetRow(mode: number, hashValue: string) {
  const [row] = await db
    .select()
    .from(projectCrackedHashes)
    .where(
      and(
        eq(projectCrackedHashes.projectId, projId),
        eq(projectCrackedHashes.hashcatMode, mode),
        eq(projectCrackedHashes.hashValue, hashValue)
      )
    )
  return row
}

beforeAll(async () => {
  await db.delete(projects).where(eq(projects.slug, SLUG))
  const [p] = await db
    .insert(projects)
    .values({ name: SLUG, slug: SLUG })
    .returning({ id: projects.id })
  projId = p!.id
  seq += 1
  const [l] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: `${SLUG}-list-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  listId = l!.id
  const [c] = await db
    .insert(campaigns)
    .values({ projectId: projId, name: `${SLUG}-camp`, hashListId: listId, status: 'running' })
    .returning({ id: campaigns.id })
  campaignId = c!.id
})

afterAll(async () => {
  await db.delete(projects).where(eq(projects.slug, SLUG))
})

describe('migration 0044 — cracked-set backfill + safe repair', () => {
  it('repairs a contradicted fill, leaves unbacked fills and imports intact, and backfills the set', async () => {
    // Scenario 1 — contradiction: an authoritative agent crack of (MODE_A, V)
    // = "correct", plus a no-attribution fill of the SAME (MODE_A, V) = "wrong".
    const V = 'a'.repeat(32)
    const legitV = await insertItem(V, {
      mode: MODE_A,
      plaintext: 'correct',
      crackedAt: new Date('2026-01-01'),
      attributed: true,
    })
    // fill lives in a second list so the (hashListId, hashValue) unique index is
    // not violated by two MODE_A/V rows.
    seq += 1
    const [l2] = await db
      .insert(hashLists)
      .values({ projectId: projId, name: `${SLUG}-list2-${seq}`, status: 'ready' })
      .returning({ id: hashLists.id })
    const listId2 = l2!.id
    const [fillV] = await db
      .insert(hashItems)
      .values({
        hashListId: listId2,
        hashValue: V,
        detectedHashcatMode: MODE_A,
        plaintext: 'wrong',
        crackedAt: new Date('2026-02-01'),
        agentId: null,
      })
      .returning({ id: hashItems.id })

    // Scenario 2 — unbacked fill: (MODE_B, W) filled with no attributed backing.
    const W = 'b'.repeat(32)
    const unbacked = await insertItem(W, {
      mode: MODE_B,
      plaintext: 'maybe-wrong',
      crackedAt: new Date('2026-02-01'),
    })

    // Scenario 3 — legitimate precracked import: source='import', no attribution.
    const X = 'c'.repeat(32)
    const importItem = await insertItem(X, {
      mode: MODE_A,
      plaintext: 'imported-pw',
      crackedAt: new Date('2026-02-01'),
      source: 'import',
    })

    await runMigration()

    // Repair: the contradicted fill is aligned to the authoritative plaintext.
    expect(await itemPlaintext(fillV.id)).toBe('correct')
    expect(await itemPlaintext(legitV)).toBe('correct')
    // Safety: the unbacked fill and the import are untouched.
    expect(await itemPlaintext(unbacked)).toBe('maybe-wrong')
    expect(await itemPlaintext(importItem)).toBe('imported-pw')

    // Backfill: every cracked (mode, value) is now in the set; (MODE_A, V) prefers
    // the authoritative plaintext and keeps its historical original_cracked_at.
    const setV = await crackedSetRow(MODE_A, V)
    expect(setV).toBeDefined()
    expect(setV!.plaintext).toBe('correct')
    expect(setV!.originalCrackedAt?.toISOString()).toBe(new Date('2026-01-01').toISOString())
    // KTD2: keyset cracked_at stamped NOW (>= the historical crack).
    expect(setV!.crackedAt.getTime()).toBeGreaterThanOrEqual(new Date('2026-01-01').getTime())
    expect(await crackedSetRow(MODE_B, W)).toBeDefined()
    expect(await crackedSetRow(MODE_A, X)).toBeDefined()

    // Idempotent: a second run inserts nothing new and does not move cracked_at.
    const before = setV!.crackedAt.getTime()
    await runMigration()
    const after = await crackedSetRow(MODE_A, V)
    expect(after!.crackedAt.getTime()).toBe(before)
  })

  it('excludes mode-less cracked rows from the backfill (KTD3)', async () => {
    const Y = 'd'.repeat(32)
    await insertItem(Y, { mode: null, plaintext: 'nomode', crackedAt: new Date('2026-02-01') })
    await runMigration()
    const anyY = await db
      .select()
      .from(projectCrackedHashes)
      .where(and(eq(projectCrackedHashes.projectId, projId), eq(projectCrackedHashes.hashValue, Y)))
    expect(anyY).toHaveLength(0)
  })
})
