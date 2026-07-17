/**
 * Real-DB tests for issue #202 SU2 — mixed hash-list split analysis.
 *
 * Tests call `runSplitAnalysis` directly — the testable DB core exported
 * from `queue/workers/hash-list-split.ts` — bypassing Redis entirely (the
 * db test lane has no live Redis, mirrors `hash-import.db.test.ts` calling
 * `processImportPairs` directly).
 *
 * Fixture note (verified against the real HASH_PATTERNS table, not
 * assumed — see split-analysis.test.ts for the same caveat): a raw 32-hex
 * string is AMBIGUOUS (NTLM/LM/MD5/MD4 collide on length), and a raw
 * 128-hex string is ALSO ambiguous (SHA-512/Whirlpool collide). The
 * confident fixture here is a SHA-512 Crypt string (`$6$...`, hashcatMode
 * 1800) since it is `$`-prefixed and matches only one pattern.
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
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { runSplitAnalysis } from '../../src/queue/workers/hash-list-split.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SHA512_CRYPT_MODE = 1800
const HEX32_SIGNATURE = [0, 900, 1000, 3000]

function sha512Crypt(salt: string): string {
  return `$6$${salt}$${'A'.repeat(86)}`
}

const HEX32 = 'c'.repeat(32)

function garbage(i: number): string {
  return `garbage-unidentifiable-line-${i}`
}

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ = 'hash-list-split-proj'

let projId: number

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createReadyHashList(name: string): Promise<number> {
  const [list] = await db
    .insert(hashLists)
    .values({ projectId: projId, name, status: 'ready' })
    .returning({ id: hashLists.id })
  return list!.id
}

async function insertHashValues(hashListId: number, values: readonly string[]): Promise<void> {
  if (values.length === 0) return
  await db.insert(hashItems).values(values.map((hashValue) => ({ hashListId, hashValue })))
}

async function childrenOf(parentHashListId: number) {
  return db.select().from(hashLists).where(eq(hashLists.parentHashListId, parentHashListId))
}

async function itemsOf(hashListId: number) {
  return db.select().from(hashItems).where(eq(hashItems.hashListId, hashListId))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runSplitAnalysis — real split (mixed confident + ambiguous + unidentified)', () => {
  it('creates one sub-list per group, moves items, and sets per-kind detected_hashcat_mode / type_analysis', async () => {
    const parentId = await createReadyHashList('split-mixed-parent')
    const confidentValues = [sha512Crypt('salt0001'), sha512Crypt('salt0002')]
    const ambiguousValues = [HEX32, 'd'.repeat(32)]
    const unidentifiedValues = [garbage(0)]
    await insertHashValues(parentId, [
      ...confidentValues,
      ...ambiguousValues,
      ...unidentifiedValues,
    ])

    const result = await runSplitAnalysis(parentId)

    expect(result.outcome).toBe('split')
    expect(result.subLists).toHaveLength(3)

    // ── Parent shell is empty of the moved items ──
    const parentItems = await itemsOf(parentId)
    expect(parentItems).toHaveLength(0)

    // ── Children exist, share the parent's project, and item counts sum to the parent's original total ──
    const children = await childrenOf(parentId)
    expect(children).toHaveLength(3)
    for (const child of children) {
      expect(child.projectId).toBe(projId)
      expect(child.parentHashListId).toBe(parentId)
    }
    const totalChildItems = await Promise.all(children.map((c) => itemsOf(c.id)))
    const totalCount = totalChildItems.reduce((sum, rows) => sum + rows.length, 0)
    expect(totalCount).toBe(
      confidentValues.length + ambiguousValues.length + unidentifiedValues.length
    )

    // ── Confident sub-list: detected_hashcat_mode set + homogeneous type_analysis ──
    const confidentSummary = result.subLists.find((s) => s.kind === 'confident')
    expect(confidentSummary).toBeDefined()
    expect(confidentSummary?.mode).toBe(SHA512_CRYPT_MODE)
    expect(confidentSummary?.itemCount).toBe(confidentValues.length)
    const confidentRows = await itemsOf(confidentSummary!.id)
    expect(confidentRows).toHaveLength(confidentValues.length)
    for (const row of confidentRows) {
      expect(row.detectedHashcatMode).toBe(SHA512_CRYPT_MODE)
    }
    const [confidentList] = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, confidentSummary!.id))
    expect(confidentList!.typeAnalysis?.verdict).toBe('homogeneous')
    expect(confidentList!.typeAnalysis?.detectedModes).toEqual([
      { hashcatMode: SHA512_CRYPT_MODE, count: confidentValues.length },
    ])

    // ── Ambiguous sub-list: null mode, needs-review, candidate modes surfaced ──
    const ambiguousSummary = result.subLists.find((s) => s.kind === 'ambiguous')
    expect(ambiguousSummary).toBeDefined()
    expect(ambiguousSummary?.mode).toBeNull()
    expect(ambiguousSummary?.itemCount).toBe(ambiguousValues.length)
    const ambiguousRows = await itemsOf(ambiguousSummary!.id)
    expect(ambiguousRows).toHaveLength(ambiguousValues.length)
    for (const row of ambiguousRows) {
      expect(row.detectedHashcatMode).toBeNull()
    }
    const [ambiguousList] = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, ambiguousSummary!.id))
    expect(ambiguousList!.typeAnalysis?.verdict).toBe('needs-review')
    expect(ambiguousList!.typeAnalysis?.detectedModes).toEqual(
      HEX32_SIGNATURE.map((hashcatMode) => ({ hashcatMode, count: ambiguousValues.length }))
    )

    // ── Unidentified sub-list: null mode, needs-review, empty detectedModes ──
    const unidentifiedSummary = result.subLists.find((s) => s.kind === 'unidentified')
    expect(unidentifiedSummary).toBeDefined()
    expect(unidentifiedSummary?.mode).toBeNull()
    expect(unidentifiedSummary?.itemCount).toBe(unidentifiedValues.length)
    const unidentifiedRows = await itemsOf(unidentifiedSummary!.id)
    expect(unidentifiedRows).toHaveLength(unidentifiedValues.length)
    for (const row of unidentifiedRows) {
      expect(row.detectedHashcatMode).toBeNull()
    }
    const [unidentifiedList] = await db
      .select()
      .from(hashLists)
      .where(eq(hashLists.id, unidentifiedSummary!.id))
    expect(unidentifiedList!.typeAnalysis?.verdict).toBe('needs-review')
    expect(unidentifiedList!.typeAnalysis?.detectedModes).toEqual([])
    expect(unidentifiedList!.typeAnalysis?.unidentifiedCount).toBe(unidentifiedValues.length)
  })

  it('is idempotent: a second call on an already-split parent is a no-op', async () => {
    const parentId = await createReadyHashList('split-idempotent-parent')
    await insertHashValues(parentId, [sha512Crypt('idem0001'), HEX32])

    const first = await runSplitAnalysis(parentId)
    expect(first.outcome).toBe('split')
    const childrenAfterFirst = await childrenOf(parentId)
    expect(childrenAfterFirst).toHaveLength(2)

    const second = await runSplitAnalysis(parentId)
    expect(second.outcome).toBe('already-split')

    const childrenAfterSecond = await childrenOf(parentId)
    expect(childrenAfterSecond).toHaveLength(2)
    const numericAsc = (a: number, b: number): number => a - b
    expect(childrenAfterSecond.map((c) => c.id).sort(numericAsc)).toEqual(
      childrenAfterFirst.map((c) => c.id).sort(numericAsc)
    )

    // The already-split reconstruction (summarizeExistingChildren) must
    // report the same kind/mode as the original split — this is the
    // contract SU3 reads on a re-driven job, not just a raw child count.
    const reconstructedConfident = second.subLists.find((s) => s.kind === 'confident')
    expect(reconstructedConfident?.mode).toBe(SHA512_CRYPT_MODE)
    expect(reconstructedConfident?.itemCount).toBe(1)
    const reconstructedAmbiguous = second.subLists.find((s) => s.kind === 'ambiguous')
    expect(reconstructedAmbiguous?.mode).toBeNull()
    expect(reconstructedAmbiguous?.itemCount).toBe(1)
  })
})

describe('runSplitAnalysis — degenerate cases', () => {
  it('does not create children for a homogeneous (single confident group) parent', async () => {
    const parentId = await createReadyHashList('split-degenerate-single-group')
    await insertHashValues(parentId, [sha512Crypt('deg00001'), sha512Crypt('deg00002')])

    const result = await runSplitAnalysis(parentId)

    expect(result.outcome).toBe('degenerate-single-group')
    expect(result.subLists).toEqual([])
    const children = await childrenOf(parentId)
    expect(children).toHaveLength(0)
    const parentItems = await itemsOf(parentId)
    expect(parentItems).toHaveLength(2)
  })

  it('does not create children for an empty parent', async () => {
    const parentId = await createReadyHashList('split-degenerate-empty')

    const result = await runSplitAnalysis(parentId)

    expect(result.outcome).toBe('degenerate-empty')
    expect(result.subLists).toEqual([])
    const children = await childrenOf(parentId)
    expect(children).toHaveLength(0)
  })

  it('throws for a non-existent parent', async () => {
    const nonExistentId = 2_147_483_647
    await expect(runSplitAnalysis(nonExistentId)).rejects.toThrow(
      `Hash list ${nonExistentId} not found`
    )
  })
})
