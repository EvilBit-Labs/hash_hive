/**
 * Prepare the real-DB integration test database.
 *
 * The backend test suite is split into two lanes:
 *   1. The default lane (`tests/unit`, `tests/integration`) mocks the drizzle
 *      client and needs no database — this is what CI's `just test` runs and
 *      what runs without any Postgres service.
 *   2. The real-DB lane (`tests/db`) exercises behaviour that only a live
 *      Postgres/TimescaleDB instance can prove: LISTEN/NOTIFY transport, the
 *      `FOR UPDATE SKIP LOCKED` claim CTE, lease reclaim, and the telemetry
 *      hypertable. These tests connect for real and must NOT self-skip when a
 *      database is missing — a skipped real-DB test reads green while proving
 *      nothing, which is worse than no test. So this script runs first and
 *      fails loudly if the database is unreachable.
 *
 * Idempotent: creates the `hashhive_test` database if absent (locally), then
 * applies all drizzle migrations. In CI the service container already creates
 * the database via `POSTGRES_DB`, so the CREATE is a no-op there.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Deliberately does NOT fall back to the ambient `DATABASE_URL`: the justfile
// loads `.env` (dotenv-load), which points `DATABASE_URL` at the dev database.
// The real-DB lane must run against a separate `hashhive_test` so it never
// migrates or pollutes dev data. Override only via an explicit `TEST_DATABASE_URL`.
const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://hashhive:hashhive@localhost:5432/hashhive_test'

// Migrations live in the shared package; this script runs with the backend
// package as cwd (`bun --filter @hashhive/backend ...`), mirroring the path in
// drizzle.config.ts.
const MIGRATIONS_FOLDER = '../shared/src/db/migrations'

function maintenanceUrl(testUrl: string): string {
  // Connect to the always-present `postgres` database to issue CREATE DATABASE,
  // since the target database may not exist yet.
  const url = new URL(testUrl)
  url.pathname = '/postgres'
  return url.toString()
}

function testDatabaseName(testUrl: string): string {
  return new URL(testUrl).pathname.replace(/^\//, '')
}

async function ensureDatabaseExists(testUrl: string): Promise<void> {
  const dbName = testDatabaseName(testUrl)
  const admin = postgres(maintenanceUrl(testUrl), { max: 1, onnotice: () => {} })
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
    if (existing.length === 0) {
      // Database identifiers cannot be parameterised; dbName is derived from a
      // trusted env URL, not user input.
      await admin.unsafe(`CREATE DATABASE "${dbName}"`)
      console.log(`[setup-test-db] created database "${dbName}"`)
    } else {
      console.log(`[setup-test-db] database "${dbName}" already exists`)
    }
  } finally {
    await admin.end()
  }
}

async function applyMigrations(testUrl: string): Promise<void> {
  const sql = postgres(testUrl, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER })
    console.log('[setup-test-db] migrations applied')
  } finally {
    await sql.end()
  }
}

async function main(): Promise<void> {
  console.log(`[setup-test-db] preparing ${testDatabaseName(TEST_DATABASE_URL)}`)
  await ensureDatabaseExists(TEST_DATABASE_URL)
  await applyMigrations(TEST_DATABASE_URL)
  console.log('[setup-test-db] ready')
}

main().catch((err: unknown) => {
  console.error('[setup-test-db] failed:', err)
  process.exit(1)
})
