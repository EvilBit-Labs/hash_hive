/**
 * Real-DB tests for U1: hash_items.username + source columns, hashValue index,
 * and the one-shot backfill from metadata->>'username' (migration 0030).
 *
 * Tests prove:
 * 1. The new columns exist and the hashValue index was created.
 * 2. The backfill SQL populates username from metadata->>'username' for rows
 *    that have it, and leaves username NULL for rows that do not.
 * 3. The updated parser (parseHashLine) writes the username column and
 *    source='upload' for all line formats.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import { hashItems, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { parseHashLine } from '../../src/queue/workers/hash-list-parser.js'

const TEST_SLUG = 'hash-items-metadata-db-test-proj'

// ─── Seed helpers ────────────────────────────────────────────────────────────

let projectId: number
let hashListId: number

async function seedProject(): Promise<number> {
  const [row] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  return row!.id
}

async function seedHashList(pid: number): Promise<number> {
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: pid, name: 'test-hash-list', status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

async function cleanupSeed(): Promise<void> {
  // hash_items deleted by cascade when hash_list is deleted
  await db.delete(hashLists).where(eq(hashLists.id, hashListId))
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  projectId = await seedProject()
  hashListId = await seedHashList(projectId)
})

afterAll(async () => {
  await cleanupSeed()
})

// ─── Schema: columns + index ─────────────────────────────────────────────────

describe('hash_items schema (migration 0030)', () => {
  it('has the username column (varchar 255, nullable)', async () => {
    const rows = await db.execute<{
      column_name: string
      data_type: string
      character_maximum_length: number | null
      is_nullable: string
    }>(sql`
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'hash_items'
        AND column_name  = 'username'
    `)
    expect(rows.length).toBe(1)
    const col = rows[0]!
    expect(col.column_name).toBe('username')
    expect(col.data_type).toBe('character varying')
    expect(col.character_maximum_length).toBe(255)
    expect(col.is_nullable).toBe('YES')
  })

  it('has the source column (varchar 32, nullable)', async () => {
    const rows = await db.execute<{
      column_name: string
      data_type: string
      character_maximum_length: number | null
      is_nullable: string
    }>(sql`
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'hash_items'
        AND column_name  = 'source'
    `)
    expect(rows.length).toBe(1)
    const col = rows[0]!
    expect(col.column_name).toBe('source')
    expect(col.data_type).toBe('character varying')
    expect(col.character_maximum_length).toBe(32)
    expect(col.is_nullable).toBe('YES')
  })

  it('has the hash_items_hash_value_idx index on hash_value', async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename  = 'hash_items'
        AND indexname  = 'hash_items_hash_value_idx'
    `)
    expect(rows.length).toBe(1)
    expect(rows[0]!.indexname).toBe('hash_items_hash_value_idx')
    // Verify it is a non-unique btree index on hash_value
    expect(rows[0]!.indexdef).toContain('hash_value')
    expect(rows[0]!.indexdef).not.toContain('UNIQUE')
  })
})

// ─── Backfill: metadata->>'username' → username column ───────────────────────

describe('backfill: metadata.username → username column', () => {
  it('populates username from metadata when metadata has username key', async () => {
    // Insert a row with metadata.username set but username column null
    // (simulates pre-migration data). We set username explicitly to null
    // to mirror the state before the backfill ran.
    const [row] = await db
      .insert(hashItems)
      .values({
        hashListId,
        hashValue: 'backfill-test-hash-with-user',
        metadata: { username: 'backfillUser' },
        username: null,
      })
      .returning({ id: hashItems.id })

    const testId = row!.id

    try {
      // Run the exact backfill SQL from the migration, scoped to this test row.
      await db.execute(sql`
        UPDATE hash_items
        SET username = metadata->>'username'
        WHERE (metadata ? 'username') AND id = ${testId}
      `)

      const [updated] = await db
        .select({ username: hashItems.username })
        .from(hashItems)
        .where(eq(hashItems.id, testId))

      expect(updated!.username).toBe('backfillUser')
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, testId))
    }
  })

  it('leaves username NULL for rows without metadata.username', async () => {
    const [row] = await db
      .insert(hashItems)
      .values({
        hashListId,
        hashValue: 'backfill-test-hash-no-user',
        metadata: { someOtherKey: 'value' },
        username: null,
      })
      .returning({ id: hashItems.id })

    const testId = row!.id

    try {
      // Run the backfill — this row must not be touched.
      await db.execute(sql`
        UPDATE hash_items
        SET username = metadata->>'username'
        WHERE (metadata ? 'username') AND id = ${testId}
      `)

      const [checked] = await db
        .select({ username: hashItems.username })
        .from(hashItems)
        .where(eq(hashItems.id, testId))

      expect(checked!.username).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, testId))
    }
  })
})

// ─── Parser write path ────────────────────────────────────────────────────────
//
// Exercises parseHashLine against a real DB insert so we can assert the
// actual persisted column values — not just the in-memory return shape.

describe('parseHashLine → DB column writes', () => {
  it('writes username column and source="upload" for a user:hash:plain line', async () => {
    const line = 'admin:e99a18c428cb38d5f260853678922e03:secret'
    const parsed = parseHashLine(line, hashListId)
    expect(parsed).not.toBeNull()

    const [row] = await db.insert(hashItems).values(parsed!).returning({
      id: hashItems.id,
      username: hashItems.username,
      source: hashItems.source,
      plaintext: hashItems.plaintext,
      crackedAt: hashItems.crackedAt,
    })

    try {
      expect(row!.username).toBe('admin')
      expect(row!.source).toBe('upload')
      expect(row!.plaintext).toBe('secret')
      expect(row!.crackedAt).toBeInstanceOf(Date)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
    }
  })

  it('leaves username NULL for a hash:plain line', async () => {
    const line = '5f4dcc3b5aa765d61d8327deb882cf99:password'
    const parsed = parseHashLine(line, hashListId)
    expect(parsed).not.toBeNull()

    const [row] = await db.insert(hashItems).values(parsed!).returning({
      id: hashItems.id,
      username: hashItems.username,
      source: hashItems.source,
      crackedAt: hashItems.crackedAt,
    })

    try {
      expect(row!.username).toBeNull()
      expect(row!.source).toBe('upload')
      expect(row!.crackedAt).toBeInstanceOf(Date)
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
    }
  })

  it('hash-only line: username NULL, source="upload", crackedAt NULL', async () => {
    const line = 'aad3b435b51404eeaad3b435b51404ee'
    const parsed = parseHashLine(line, hashListId)
    expect(parsed).not.toBeNull()

    const [row] = await db.insert(hashItems).values(parsed!).returning({
      id: hashItems.id,
      username: hashItems.username,
      source: hashItems.source,
      crackedAt: hashItems.crackedAt,
      plaintext: hashItems.plaintext,
    })

    try {
      expect(row!.username).toBeNull()
      expect(row!.source).toBe('upload')
      expect(row!.crackedAt).toBeNull()
      expect(row!.plaintext).toBeNull()
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
    }
  })

  it('empty-username 3-token line (":hash:plain"): username NULL, source="upload"', async () => {
    // An empty username prefix must not pollute the username column with empty string.
    const line = ':aad3b435b51404eeaad3b435b51404ef:secret'
    const parsed = parseHashLine(line, hashListId)
    expect(parsed).not.toBeNull()

    const [row] = await db.insert(hashItems).values(parsed!).returning({
      id: hashItems.id,
      username: hashItems.username,
      source: hashItems.source,
    })

    try {
      expect(row!.username).toBeNull()
      expect(row!.source).toBe('upload')
    } finally {
      await db.delete(hashItems).where(eq(hashItems.id, row!.id))
    }
  })
})
