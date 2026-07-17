/**
 * Real-DB tests for issue #202 FU3/FU6 — ingestion type detection persistence.
 *
 * SCOPE NOTE (read before extending): this file does NOT drive
 * `createHashListParserWorker`'s BullMQ processor. That processor streams
 * its input from object storage (`downloadFile` in `config/storage.ts`) and
 * runs inside a real `bullmq.Worker`; the `test:db` lane provisions Postgres
 * only (no Redis, no S3/SeaweedFS — see the identical constraint documented
 * in `resource-compression-worker.db.test.ts` and `blob-reclamation.db.test.ts`).
 * Mocking `bullmq`/`config/storage.js` here would leak process-wide, because
 * `test:db` runs every file in `tests/db` in one `bun test` invocation
 * (GOTCHAS.md). Unlike `compressChunkedResourceObject` /
 * `reclaimExpiredResourceBlobs`, the parser worker has no injectable-deps
 * seam and no exported pure "parse and persist" core (only `parseHashLine`
 * and `createHashListParserWorker` are exported from
 * `queue/workers/hash-list-parser.ts`) — so there is currently no way to
 * drive the literal worker processor against real Postgres in this lane.
 *
 * What this file DOES prove, faithfully, against real Postgres:
 *   - the REAL `parseHashLine` + REAL `guessTopHashType` + REAL
 *     `buildTypeAnalysis` (all imported, not reimplemented) compose into a
 *     histogram/verdict that round-trips intact through the real
 *     `hash_lists.type_analysis` jsonb column;
 *   - that persistence rides the SAME guarded `status: 'processing' ->
 *     'ready'` UPDATE pattern the worker uses (WHERE status = 'processing');
 *   - hash_items insertion shape/count is unaffected by the type-analysis
 *     feature (R3 no-regression proof) — detection output never leaks onto
 *     hash_items rows, only onto hash_lists.type_analysis.
 *
 * The `ingestAndPersist` helper below is test-local orchestration composing
 * those three real exports plus the same `db.insert`/`db.update` calls the
 * worker issues. It is intentionally NOT a copy of the worker's batching/
 * streaming loop — see the module docstring above for why the actual
 * processor can't run here, and see FU6 report for the recommendation to
 * extract a pure `ingestHashListContent` core (out of scope for this file).
 *
 * Scale-cap (`TYPE_DETECTION_SCAN_CAP = 1_000_000`) is NOT exercised at its
 * real threshold here — seeding a million rows in a shared db-lane process
 * is not viable, and the constant isn't injectable. The pure `sampled`
 * behavior already has a dedicated unit test in
 * `tests/unit/services/hash-type-analysis.test.ts`. This file instead proves
 * a real-DB-specific corollary: when detection stops early (`sampled:
 * true`), that flag round-trips through the real jsonb column AND every row
 * still gets inserted into hash_items — i.e. sampling never gates insertion.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'

import { hashItems, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, count, eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

import { db } from '../../src/db/index.js'
import { parseHashLine } from '../../src/queue/workers/hash-list-parser.js'
import { guessTopHashType } from '../../src/services/hash-analysis.js'
import { buildTypeAnalysis } from '../../src/services/hash-items/type-analysis.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ = 'hash-type-detection-proj'

let projId: number

// ─── Fixture generators ──────────────────────────────────────────────────────

/** Unique 32-hex-char lines (matches the NTLM pattern, hashcatMode 1000 — see
 * the module docstring's caveat: 32-hex resolves to NTLM, NOT MD5, because
 * NTLM is earlier in HASH_PATTERNS' popularity order). */
function ntlmLines(n: number): string[] {
  return Array.from({ length: n }, () => randomBytes(16).toString('hex'))
}

/** Unique 128-hex-char lines (matches the SHA-512 pattern, hashcatMode 1700 —
 * SHA-512 precedes Whirlpool, the other 128-hex pattern, in popularity order). */
function sha512Lines(n: number): string[] {
  return Array.from({ length: n }, () => randomBytes(64).toString('hex'))
}

/** Lines that cannot match ANY entry in HASH_PATTERNS: hyphens immediately
 * disqualify every pattern (none allow non-hex/non-`$`/non-`*` characters). */
function garbageLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `garbage-unidentifiable-line-${i}`)
}

/** Repeats a single hash value `n` times — every repeat collides with the
 * first insert on `(hashListId, hashValue)` and is dropped by
 * `onConflictDoNothing()`, so only ONE `hash_items` row survives no matter
 * how large `n` is. */
function duplicateLines(value: string, n: number): string[] {
  return Array.from({ length: n }, () => value)
}

/**
 * Test-local orchestration of the REAL exported detection + persistence
 * primitives (parseHashLine, guessTopHashType, buildTypeAnalysis) plus the
 * same db.insert/db.update calls the worker issues. See the module
 * docstring for why this composes real exports rather than driving the
 * literal worker processor.
 *
 * Mirrors the real worker's `flushBatch` + `accumulateTypeDetection` seam
 * (issue #202 code review fix): detection runs on the rows Postgres
 * ACTUALLY inserted (`RETURNING` on an `ON CONFLICT DO NOTHING` insert only
 * reports non-colliding rows), not on every raw parsed line — a duplicate-
 * heavy fixture collapses to one `hash_items` row per distinct hash value,
 * and the histogram must reflect that deduplicated composition.
 *
 * `scanLimit` lets a test simulate an early-stopped scan (the `sampled`
 * cap) without touching the real 1,000,000-line module constant — every
 * line is still parsed and inserted; only the detection scan (now over
 * inserted rows) stops early.
 */
async function ingestAndPersist(
  hashListId: number,
  lines: readonly string[],
  declaredMode: number | null = null,
  // Default: no cap in effect (mirrors production's 1,000,000 constant being
  // far larger than any fixture here). Pass an explicit smaller value to
  // simulate an early-stopped scan — see the "sampled" describe block below.
  scanLimit: number = Number.POSITIVE_INFINITY
): Promise<{
  typeAnalysis: HashListTypeAnalysis
  flipped: boolean
  insertedCount: number
}> {
  const histogram = new Map<number, number>()
  let unidentifiedCount = 0
  let scannedCount = 0

  const batch = []
  for (const line of lines) {
    const parsed = parseHashLine(line, hashListId)
    if (parsed === null) continue
    batch.push(parsed)
  }

  const insertedRows =
    batch.length > 0
      ? await db
          .insert(hashItems)
          .values(batch)
          .onConflictDoNothing()
          .returning({ hashValue: hashItems.hashValue })
      : []

  for (const row of insertedRows) {
    if (scannedCount >= scanLimit) break
    const guess = guessTopHashType(row.hashValue)
    if (guess === null) {
      unidentifiedCount++
    } else {
      histogram.set(guess.hashcatMode, (histogram.get(guess.hashcatMode) ?? 0) + 1)
    }
    scannedCount++
  }
  const sampled = scannedCount >= scanLimit

  const [statsResult] = await db
    .select({
      total: count(),
      cracked: sql<number>`count(*) FILTER (WHERE ${hashItems.crackedAt} IS NOT NULL)`,
    })
    .from(hashItems)
    .where(eq(hashItems.hashListId, hashListId))
  const total = Number(statsResult?.total ?? 0)
  const cracked = Number(statsResult?.cracked ?? 0)
  const statistics = {
    totalCount: total,
    crackedCount: cracked,
    crackRate: total > 0 ? cracked / total : 0,
    lastUpdated: new Date().toISOString(),
  }

  const typeAnalysis = buildTypeAnalysis(
    histogram,
    unidentifiedCount,
    scannedCount,
    sampled,
    declaredMode
  )

  const flipped = await db
    .update(hashLists)
    .set({ status: 'ready', statistics, typeAnalysis, updatedAt: new Date() })
    .where(and(eq(hashLists.id, hashListId), eq(hashLists.status, 'processing')))
    .returning({ id: hashLists.id })

  return { typeAnalysis, flipped: flipped.length > 0, insertedCount: insertedRows.length }
}

async function createProcessingList(name: string): Promise<number> {
  const [list] = await db
    .insert(hashLists)
    .values({ projectId: projId, name, status: 'processing' })
    .returning({ id: hashLists.id })
  return list!.id
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ))
}

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ, slug: SLUG_PROJ })
    .returning({ id: projects.id })
  projId = p!.id
})

afterAll(async () => {
  await cleanup()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ingestion type detection — homogeneous list (R3 no-regression + verdict)', () => {
  it('inserts hash_items unchanged in shape/count AND persists a homogeneous verdict', async () => {
    const lines = sha512Lines(20)
    const listId = await createProcessingList('homogeneous-sha512')

    const result = await ingestAndPersist(listId, lines)

    // ── R3 no-regression proof (written first, per the FU6 execution note) ──
    const rows = await db
      .select({
        hashValue: hashItems.hashValue,
        hashListId: hashItems.hashListId,
        plaintext: hashItems.plaintext,
        crackedAt: hashItems.crackedAt,
        username: hashItems.username,
        source: hashItems.source,
      })
      .from(hashItems)
      .where(eq(hashItems.hashListId, listId))

    expect(rows).toHaveLength(lines.length)
    const insertedValues = new Set(rows.map((r) => r.hashValue))
    for (const line of lines) {
      expect(insertedValues.has(line)).toBe(true)
    }
    // Shape: type detection must not leak onto hash_items rows — only
    // hash_lists.type_analysis carries detection output.
    for (const row of rows) {
      expect(row.hashListId).toBe(listId)
      expect(row.plaintext).toBeNull()
      expect(row.crackedAt).toBeNull()
      expect(row.username).toBeNull()
      expect(row.source).toBe('upload')
    }

    // ── Verdict + persistence ──
    expect(result.flipped).toBe(true)
    expect(result.typeAnalysis.verdict).toBe('homogeneous')
    expect(result.typeAnalysis.detectedModes).toEqual([{ hashcatMode: 1700, count: 20 }])
    expect(result.typeAnalysis.unidentifiedCount).toBe(0)
    expect(result.typeAnalysis.scannedCount).toBe(20)
    expect(result.typeAnalysis.sampled).toBe(false)

    // Round-trip through the real jsonb column.
    const [persisted] = await db
      .select({ typeAnalysis: hashLists.typeAnalysis, status: hashLists.status })
      .from(hashLists)
      .where(eq(hashLists.id, listId))
    expect(persisted!.status).toBe('ready')
    expect(persisted!.typeAnalysis).toEqual(result.typeAnalysis)
  })
})

describe('ingestion type detection — mixed list', () => {
  it('persists verdict=mixed with both modes present at the correct counts', async () => {
    const ntlm = ntlmLines(10)
    const sha512 = sha512Lines(10)
    const listId = await createProcessingList('mixed-ntlm-sha512')

    const result = await ingestAndPersist(listId, [...ntlm, ...sha512])

    const rows = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(eq(hashItems.hashListId, listId))
    expect(rows).toHaveLength(20)

    expect(result.typeAnalysis.verdict).toBe('mixed')
    const modes = new Map(result.typeAnalysis.detectedModes.map((m) => [m.hashcatMode, m.count]))
    expect(modes.get(1000)).toBe(10) // NTLM (32-hex)
    expect(modes.get(1700)).toBe(10) // SHA-512 (128-hex)
    expect(result.typeAnalysis.unidentifiedCount).toBe(0)
    expect(result.typeAnalysis.scannedCount).toBe(20)

    const [persisted] = await db
      .select({ typeAnalysis: hashLists.typeAnalysis })
      .from(hashLists)
      .where(eq(hashLists.id, listId))
    expect(persisted!.typeAnalysis).toEqual(result.typeAnalysis)
  })
})

describe('ingestion type detection — duplicate-heavy list (issue #202 code review fix)', () => {
  it('detects on the DEDUPLICATED hash_items composition, not raw parsed lines — a single value repeated hundreds of times cannot drown out a smaller set of genuinely distinct hashes', async () => {
    const [dupValue] = sha512Lines(1)
    // 990 raw lines, all the SAME SHA-512 value — onConflictDoNothing
    // collapses these to exactly ONE hash_items row.
    const duplicateHeavy = duplicateLines(dupValue!, 990)
    // 10 raw lines, each a DISTINCT NTLM value — all 10 survive dedup.
    const ntlm = ntlmLines(10)
    const listId = await createProcessingList('duplicate-heavy-mixed')

    const result = await ingestAndPersist(listId, [...duplicateHeavy, ...ntlm])

    // Only 11 rows land in hash_items: 1 deduplicated SHA-512 + 10 distinct
    // NTLM — proves the fixture's duplicates never reach the table twice.
    const rows = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(eq(hashItems.hashListId, listId))
    expect(rows).toHaveLength(11)

    // Pre-fix (raw-line counting, the bug): SHA-512 = 990/1000 = 99% of raw
    // lines, NTLM = 10/1000 = 1% — below the 5% noise floor, so the
    // pre-fix histogram would have called this list `homogeneous` (SHA-512
    // only) and silently skipped the split flow at campaign create.
    //
    // Post-fix (deduplicated composition, correct): SHA-512 = 1/11 ~= 9.1%
    // and NTLM = 10/11 ~= 90.9% of INSERTED rows — both clear the noise
    // floor, so the correct verdict is `mixed`.
    expect(result.insertedCount).toBe(11)
    expect(result.typeAnalysis.scannedCount).toBe(11)
    expect(result.typeAnalysis.verdict).toBe('mixed')
    const modes = new Map(result.typeAnalysis.detectedModes.map((m) => [m.hashcatMode, m.count]))
    expect(modes.get(1700)).toBe(1) // SHA-512, deduplicated down to one row
    expect(modes.get(1000)).toBe(10) // NTLM, ten genuinely distinct rows
    expect(result.typeAnalysis.unidentifiedCount).toBe(0)

    const [persisted] = await db
      .select({ typeAnalysis: hashLists.typeAnalysis })
      .from(hashLists)
      .where(eq(hashLists.id, listId))
    expect(persisted!.typeAnalysis?.verdict).toBe('mixed')
  })
})

describe('ingestion type detection — unidentifiable-dominant list', () => {
  it('counts unidentifiable lines correctly and flips verdict to needs-review once they dominate', async () => {
    const identifiable = sha512Lines(3)
    const garbage = garbageLines(7)
    const listId = await createProcessingList('unidentified-dominant')

    const result = await ingestAndPersist(listId, [...identifiable, ...garbage])

    const rows = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(eq(hashItems.hashListId, listId))
    expect(rows).toHaveLength(10)

    // 7/10 = 70% unidentified >= the 50% dominance threshold -> needs-review,
    // regardless of the identifiable 128-hex entries clearing the noise floor.
    expect(result.typeAnalysis.unidentifiedCount).toBe(7)
    expect(result.typeAnalysis.scannedCount).toBe(10)
    expect(result.typeAnalysis.verdict).toBe('needs-review')

    const [persisted] = await db
      .select({ typeAnalysis: hashLists.typeAnalysis })
      .from(hashLists)
      .where(eq(hashLists.id, listId))
    expect(persisted!.typeAnalysis?.unidentifiedCount).toBe(7)
    expect(persisted!.typeAnalysis?.verdict).toBe('needs-review')
  })
})

describe('ingestion type detection — sampled scan does not gate row insertion', () => {
  it('stops the detection scan early (sampled=true) while every line still lands in hash_items', async () => {
    const lines = sha512Lines(20)
    const listId = await createProcessingList('sampled-cap-corollary')

    // scanLimit=5 simulates an early-stopped cap (see module docstring —
    // the real 1,000,000 constant isn't injectable/exercisable in this lane).
    const result = await ingestAndPersist(listId, lines, null, 5)

    const rows = await db
      .select({ id: hashItems.id })
      .from(hashItems)
      .where(eq(hashItems.hashListId, listId))
    // Every line inserted despite the scan stopping at 5.
    expect(rows).toHaveLength(20)

    expect(result.typeAnalysis.sampled).toBe(true)
    expect(result.typeAnalysis.scannedCount).toBe(5)
    expect(result.typeAnalysis.detectedModes).toEqual([{ hashcatMode: 1700, count: 5 }])

    const [persisted] = await db
      .select({ typeAnalysis: hashLists.typeAnalysis })
      .from(hashLists)
      .where(eq(hashLists.id, listId))
    // sampled:true must round-trip through the real jsonb column.
    expect(persisted!.typeAnalysis?.sampled).toBe(true)
    expect(persisted!.typeAnalysis?.scannedCount).toBe(5)
  })
})

describe('ingestion type detection — guarded flip (status must be processing)', () => {
  it('does not overwrite type_analysis when the list is already ready (concurrent-processor guard)', async () => {
    const listId = await createProcessingList('already-ready-guard')
    // Flip it to ready out-of-band, simulating a concurrent processor run.
    await db.update(hashLists).set({ status: 'ready' }).where(eq(hashLists.id, listId))

    const result = await ingestAndPersist(listId, sha512Lines(4))

    // The WHERE status='processing' guard matches zero rows.
    expect(result.flipped).toBe(false)

    const [persisted] = await db
      .select({ typeAnalysis: hashLists.typeAnalysis, status: hashLists.status })
      .from(hashLists)
      .where(eq(hashLists.id, listId))
    expect(persisted!.status).toBe('ready')
    // type_analysis was never written because the guarded UPDATE was a no-op.
    expect(persisted!.typeAnalysis).toBeNull()
  })
})
