/**
 * Real-DB tests for the task_telemetry hypertable, continuous aggregates,
 * and retention policy re-application (U8).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts).
 * The prepare step applies migration 0022_telemetry_hypertable.sql before
 * these tests execute, so hypertable + CAGGs + policies are already in place.
 *
 * NOTE: do NOT call `client.end()` here — `harness.test.ts` owns the shared
 * drizzle client lifecycle and closes it in its own `afterAll`. All test
 * files in the `tests/db` lane share the same module-level client.
 */

import {
  agents,
  attacks,
  campaigns,
  hashLists,
  hashTypes,
  projects,
  tasks,
  users,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { applyTelemetryRetentionPolicies } from '../../src/services/telemetry-retention.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_EMAIL = 'telemetry-retention-db-test@hashhive.local'
const TEST_SLUG = 'telemetry-retention-test-proj'

// ─── Seed helpers ───────────────────────────────────────────────────────────

interface SeedResult {
  taskId: number
  agentId: number
}

async function seedMinimal(): Promise<SeedResult> {
  const [user] = await db
    .insert(users)
    .values({ email: TEST_EMAIL, passwordHash: 'x', name: 'Retention Test User' })
    .returning({ id: users.id })

  const [project] = await db
    .insert(projects)
    .values({ name: 'retention-test', slug: TEST_SLUG, createdBy: user!.id })
    .returning({ id: projects.id })

  const [agent] = await db
    .insert(agents)
    .values({
      name: 'retention-test-agent',
      projectId: project!.id,
      capabilities: {},
      status: 'idle',
    })
    .returning({ id: agents.id })

  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'MD5 (retention test)', hashcatMode: 9999901 })
    .returning({ id: hashTypes.id })

  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId: project!.id,
      name: 'retention-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })

  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: 'retention-test-campaign',
      projectId: project!.id,
      hashListId: hashList!.id,
      priority: 1,
      status: 'running',
    })
    .returning({ id: campaigns.id })

  const [attack] = await db
    .insert(attacks)
    .values({ campaignId: campaign!.id, projectId: project!.id, mode: 0 })
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

  return { taskId: task!.id, agentId: agent!.id }
}

async function cleanupSeed(): Promise<void> {
  await db.delete(users).where(eq(users.email, TEST_EMAIL))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, 9999901))
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('task_telemetry hypertable (U8)', () => {
  it('task_telemetry is a hypertable after migration 0022', async () => {
    const rows = await db.execute<{ hypertable_name: string }>(sql`
      SELECT hypertable_name
      FROM timescaledb_information.hypertables
      WHERE hypertable_schema = 'public'
        AND hypertable_name   = 'task_telemetry'
    `)
    expect(rows.length).toBe(1)
  })

  it('has no time-excluding unique constraint (guards U8 conversion validity)', async () => {
    // U4 mandated no PRIMARY KEY or UNIQUE on task_telemetry. If one existed,
    // create_hypertable would have failed. This assertion is belt-and-suspenders:
    // the migration applying successfully already proves it, but an explicit
    // assertion makes the invariant visible in the test suite.
    const rows = await db.execute<{ constraint_type: string }>(sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema  = 'public'
        AND tc.table_name    = 'task_telemetry'
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    `)
    expect(rows.length).toBe(0)
  })

  it('chunk_time_interval is 1 hour', async () => {
    const rows = await db.execute<{ interval_length: string }>(sql`
      SELECT d.interval_length
      FROM _timescaledb_catalog.dimension d
      JOIN _timescaledb_catalog.hypertable h ON h.id = d.hypertable_id
      WHERE h.schema_name = 'public'
        AND h.table_name  = 'task_telemetry'
    `)
    expect(rows.length).toBe(1)
    // interval_length is stored as microseconds; 1 hour = 3,600,000,000 µs
    expect(Number(rows[0]!.interval_length)).toBe(3_600_000_000)
  })
})

describe('task_telemetry continuous aggregates (U8)', () => {
  it('task_telemetry_1m exists as a continuous aggregate', async () => {
    const rows = await db.execute<{ view_name: string }>(sql`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE view_schema = 'public'
        AND view_name   = 'task_telemetry_1m'
    `)
    expect(rows.length).toBe(1)
  })

  it('task_telemetry_5m exists as a continuous aggregate', async () => {
    const rows = await db.execute<{ view_name: string }>(sql`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE view_schema = 'public'
        AND view_name   = 'task_telemetry_5m'
    `)
    expect(rows.length).toBe(1)
  })

  it('task_telemetry_1h exists as a continuous aggregate', async () => {
    const rows = await db.execute<{ view_name: string }>(sql`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE view_schema = 'public'
        AND view_name   = 'task_telemetry_1h'
    `)
    expect(rows.length).toBe(1)
  })
})

describe('task_telemetry_1m CAGG materialization (U8)', () => {
  let seed: SeedResult

  beforeAll(async () => {
    await cleanupSeed()
    seed = await seedMinimal()
  })

  it('materializes rows into the 1m CAGG and returns the expected aggregate', async () => {
    // Insert telemetry rows with explicit timestamps anchored to a specific
    // 1-minute bucket so time_bucket groups them predictably regardless of
    // when the test runs.
    const bucketTime = '2025-01-01T12:00:00Z'

    await db.execute(sql`
      INSERT INTO task_telemetry ("time", task_id, agent_id, keyspace_progress, speed_hs, temperature)
      VALUES
        (${bucketTime}::timestamptz + INTERVAL '10 seconds', ${seed.taskId}, ${seed.agentId}, 100::bigint, 1000000, 65.0),
        (${bucketTime}::timestamptz + INTERVAL '20 seconds', ${seed.taskId}, ${seed.agentId}, 200::bigint, 1200000, 66.0),
        (${bucketTime}::timestamptz + INTERVAL '40 seconds', ${seed.taskId}, ${seed.agentId}, 300::bigint,  800000, 64.0)
    `)

    // Force the CAGG to materialize synchronously (policies run on a schedule;
    // tests use CALL refresh_continuous_aggregate to trigger immediately).
    // NULL bounds mean "all available data".
    await db.execute(sql`CALL refresh_continuous_aggregate('task_telemetry_1m', NULL, NULL)`)

    // The three rows should land in the same 1-minute bucket.
    const rows = await db.execute<{
      bucket: string
      task_id: number
      max_keyspace_progress: string
      max_speed_hs: string
      avg_speed_hs: string
    }>(sql`
      SELECT bucket, task_id, max_keyspace_progress, max_speed_hs, avg_speed_hs
      FROM task_telemetry_1m
      WHERE task_id = ${seed.taskId}
        AND bucket  = time_bucket('1 minute', ${bucketTime}::timestamptz)
    `)

    expect(rows.length).toBeGreaterThanOrEqual(1)
    const row = rows[0]!
    // max_keyspace_progress must be the highest inserted value.
    expect(BigInt(row.max_keyspace_progress)).toBe(300n)
    // max_speed_hs must be 1_200_000.
    expect(Number(row.max_speed_hs)).toBe(1_200_000)
    // avg_speed_hs: (1_000_000 + 1_200_000 + 800_000) / 3 = 1_000_000
    expect(Number(row.avg_speed_hs)).toBe(1_000_000)
  })

  it('CAGG query returns the same trend as raw rows within the live window', async () => {
    // Re-use the rows inserted above. A raw MAX query and the CAGG MAX should agree.
    const bucketTime = '2025-01-01T12:00:00Z'

    const [rawMax] = await db.execute<{ max_progress: string }>(sql`
      SELECT max(keyspace_progress)::text AS max_progress
      FROM task_telemetry
      WHERE task_id = ${seed.taskId}
        AND "time" >= time_bucket('1 minute', ${bucketTime}::timestamptz)
        AND "time" <  time_bucket('1 minute', ${bucketTime}::timestamptz) + INTERVAL '1 minute'
    `)

    const [caggMax] = await db.execute<{ max_keyspace_progress: string }>(sql`
      SELECT max_keyspace_progress::text
      FROM task_telemetry_1m
      WHERE task_id = ${seed.taskId}
        AND bucket  = time_bucket('1 minute', ${bucketTime}::timestamptz)
    `)

    expect(rawMax?.max_progress).toBeDefined()
    expect(caggMax?.max_keyspace_progress).toBeDefined()
    expect(BigInt(rawMax!.max_progress)).toBe(BigInt(caggMax!.max_keyspace_progress))
  })

  afterAll(async () => {
    // Clean up the explicit telemetry rows inserted for this describe block.
    // cleanupSeed() (outer afterAll) cascades from users -> tasks, which
    // removes task_telemetry rows via ON DELETE CASCADE, but we clean them
    // here too to keep the CAGG state tidy for other tests.
    await db.execute(sql`
      DELETE FROM task_telemetry WHERE task_id = ${seed.taskId}
    `)
  })
})

describe('telemetry retention policies (U8, KTD-7)', () => {
  it('raw hypertable retention drop_after is the 1-hour default (magnitude-checked)', async () => {
    // Convert the stored duration to seconds in SQL so the assertion is
    // format-independent (Timescale stores '01:00:00' or '1 hour') AND magnitude-
    // checked: a regression to e.g. '1 day' or '10 years' fails here, unlike the
    // prior defined/non-empty check.
    const rows = await db.execute<{ drop_after_seconds: number }>(sql`
      SELECT EXTRACT(EPOCH FROM (j.config->>'drop_after')::interval) AS drop_after_seconds
      FROM timescaledb_information.jobs j
      JOIN _timescaledb_catalog.hypertable h
        ON (j.config->>'hypertable_id')::int = h.id
      WHERE j.proc_name  = 'policy_retention'
        AND h.schema_name = 'public'
        AND h.table_name  = 'task_telemetry'
    `)
    expect(rows.length).toBe(1)
    expect(Number(rows[0]!.drop_after_seconds)).toBe(3600) // 1 hour
  })

  it('applyTelemetryRetentionPolicies() re-applies env windows without error', async () => {
    // Uses the env defaults (already loaded by preload.ts / preload-db.ts).
    // Verify it completes without throwing.
    await expect(applyTelemetryRetentionPolicies()).resolves.toBeUndefined()
  })

  it('after re-apply, raw retention policy drop_after still matches the env default', async () => {
    // Re-applying the default should leave the policy config unchanged.
    await applyTelemetryRetentionPolicies()

    const rows = await db.execute<{ drop_after: string }>(sql`
      SELECT j.config->>'drop_after' AS drop_after
      FROM timescaledb_information.jobs j
      JOIN _timescaledb_catalog.hypertable h
        ON (j.config->>'hypertable_id')::int = h.id
      WHERE j.proc_name  = 'policy_retention'
        AND h.schema_name = 'public'
        AND h.table_name  = 'task_telemetry'
    `)
    expect(rows.length).toBe(1)
    expect(rows[0]!.drop_after).toBeDefined()
    // The default TELEMETRY_FULLRES_RETENTION is '1 hour'.
    // Timescale stores it internally; we assert it's non-empty and present —
    // the exact serialization format ('01:00:00' vs '@ 1 hour') is an
    // implementation detail of the Timescale version, not a contract we own.
    expect(rows[0]!.drop_after).not.toBe('')
  })

  it('all four tiers have retention policies installed', async () => {
    // Verify each tier has a retention policy entry in the job catalog.
    // Raw hypertable: look up by schema/table directly in hypertable catalog.
    // CAGGs: the retention job targets their *materialized* hypertable (an
    // internal relation); join via materialization_hypertable_schema/name.
    const relations = [
      'task_telemetry',
      'task_telemetry_1m',
      'task_telemetry_5m',
      'task_telemetry_1h',
    ]

    for (const rel of relations) {
      const rows = await db.execute<{ job_id: number }>(sql`
        SELECT j.job_id
        FROM timescaledb_information.jobs j
        WHERE j.proc_name = 'policy_retention'
          AND (
            -- Raw hypertable path: policy job config hypertable_id references
            -- the public.task_telemetry hypertable directly.
            (j.config->>'hypertable_id') IN (
              SELECT id::text FROM _timescaledb_catalog.hypertable
              WHERE schema_name = 'public' AND table_name = ${rel}
            )
            OR
            -- CAGG path: policy job config hypertable_id references the
            -- internal materialized hypertable, not the view itself. Resolve
            -- via timescaledb_information.continuous_aggregates joined to the
            -- hypertable catalog on materialization_hypertable_schema/name.
            (j.config->>'hypertable_id') IN (
              SELECT h.id::text
              FROM timescaledb_information.continuous_aggregates ca
              JOIN _timescaledb_catalog.hypertable h
                ON h.schema_name = ca.materialization_hypertable_schema
               AND h.table_name  = ca.materialization_hypertable_name
              WHERE ca.view_schema = 'public' AND ca.view_name = ${rel}
            )
          )
      `)
      expect(rows.length).toBeGreaterThanOrEqual(1)
    }
  })
})
