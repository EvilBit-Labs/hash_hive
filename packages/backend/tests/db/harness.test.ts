/**
 * Canonical real-DB lane smoke test.
 *
 * Proves the `tests/db` harness actually works end to end:
 *   - the real drizzle/postgres client connects to `hashhive_test`,
 *   - migrations have been applied (core tables exist),
 *   - real transactions round-trip.
 *
 * This file deliberately does NOT mock the database and does NOT self-skip when
 * a database is missing. If the lane is misconfigured, these tests fail loudly
 * rather than passing vacuously — a green-but-skipped real-DB test is false
 * coverage. The lane is prepared by `setup-test-db.ts` (run via `just test-db`)
 * and runs only under `--preload ./tests/preload-db.ts`, so it never executes in
 * the default mocked `bun test` lane.
 */

import { describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

// NOTE: do NOT call client.end() here. The pooled `client` from src/db/index.js
// is a singleton shared by every test file in the `tests/db` lane (bun:test runs
// them in one process). Ending it from any one file's afterAll closes the
// connection for files that run later, surfacing as CONNECTION_ENDED. bun
// force-exits the process when the run completes, so leaving the pool open is
// fine and the lane still finishes promptly.

describe('real-DB harness', () => {
  it('connects to the live test database', async () => {
    const rows = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`)
    expect(rows[0]?.ok).toBe(1)
  })

  it('has the core schema migrated', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `)
    const tableNames = new Set(rows.map((r) => r.table_name))
    for (const expected of ['tasks', 'agents', 'campaigns', 'hash_items', 'agent_benchmarks']) {
      expect(tableNames.has(expected)).toBe(true)
    }
  })

  it('round-trips a real transaction with rollback', async () => {
    // Prove the connection supports real transactional writes without leaving
    // residue: insert into a session-scoped temp table inside a transaction,
    // read it back, then roll the whole thing back.
    let observed = 0
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE _harness_probe (v int) ON COMMIT DROP`)
        await tx.execute(sql`INSERT INTO _harness_probe (v) VALUES (42)`)
        const probe = await tx.execute<{ v: number }>(sql`SELECT v FROM _harness_probe`)
        observed = probe[0]?.v ?? 0
        // Force rollback so the test leaves no trace.
        tx.rollback()
      })
      .catch((err: unknown) => {
        // drizzle signals an intentional rollback by throwing; swallow only that.
        if (!(err instanceof Error) || !err.message.includes('Rollback')) throw err
      })
    expect(observed).toBe(42)
  })
})
