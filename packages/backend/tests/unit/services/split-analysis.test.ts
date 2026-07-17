/**
 * Unit tests for the split-analysis helper (issue #202, unit SU2).
 *
 * Design: pure classification/grouping logic; no DB connection, no
 * mock.module, no IS_ISOLATED env gate. Runs in the shared `bun test` phase
 * (mirrors tests/unit/services/hash-type-analysis.test.ts).
 *
 * Fixture note (verified against the real HASH_PATTERNS table, not assumed):
 *   - A raw 32-hex string is AMBIGUOUS, not confident — it matches NTLM
 *     (1000), LM (3000), MD5 (0), and MD4 (900), all sharing
 *     `/^[a-fA-F0-9]{32}$/`.
 *   - A raw 128-hex string is ALSO ambiguous — SHA-512 (1700) and Whirlpool
 *     (6100) share `/^[a-fA-F0-9]{128}$/`. It is NOT a safe "confident"
 *     fixture despite looking unique-length.
 *   - The confident fixture here is a SHA-512 Crypt string (`$6$...`,
 *     hashcatMode 1800) — `$`-prefixed, so no raw-hex pattern co-matches.
 */

import { describe, expect, it } from 'bun:test'

import { classifyEntry, planSplit } from '../../../src/services/hash-items/split-analysis.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Confident: SHA-512 Crypt, single candidate, hashcatMode 1800. */
const SHA512_CRYPT = `$6$abcdefgh$${'A'.repeat(86)}`
const SHA512_CRYPT_MODE = 1800

/** Ambiguous: 32-hex, matches NTLM(1000)/LM(3000)/MD5(0)/MD4(900). */
const HEX32 = 'c'.repeat(32)
const HEX32_SIGNATURE = [0, 900, 1000, 3000]

/** Unidentified: matches no pattern in HASH_PATTERNS. */
function garbage(i: number): string {
  return `garbage-unidentifiable-line-${i}`
}

// ─── classifyEntry ───────────────────────────────────────────────────────────

describe('classifyEntry', () => {
  it('classifies a single-candidate structured hash as confident', () => {
    expect(classifyEntry(SHA512_CRYPT)).toEqual({ kind: 'confident', mode: SHA512_CRYPT_MODE })
  })

  it('classifies a same-length-collision raw hex string as ambiguous with the full sorted signature', () => {
    expect(classifyEntry(HEX32)).toEqual({ kind: 'ambiguous', signature: HEX32_SIGNATURE })
  })

  it('classifies an unrecognized string as unidentified', () => {
    expect(classifyEntry(garbage(0))).toEqual({ kind: 'unidentified' })
  })
})

// ─── planSplit ────────────────────────────────────────────────────────────────

describe('planSplit', () => {
  it('returns degenerate "empty" for zero items', () => {
    const plan = planSplit([])
    expect(plan.degenerate).toBe('empty')
    expect(plan.groups).toEqual([])
  })

  it('returns degenerate "single-group" for an all-confident-same-mode list', () => {
    const items = [
      { id: 1, hashValue: SHA512_CRYPT },
      { id: 2, hashValue: `$6$otherslt$${'B'.repeat(86)}` },
    ]

    const plan = planSplit(items)

    expect(plan.degenerate).toBe('single-group')
    expect(plan.groups).toEqual([{ kind: 'confident', mode: SHA512_CRYPT_MODE, itemIds: [1, 2] }])
  })

  it('returns degenerate "single-group" for an all-unidentified list', () => {
    const items = [
      { id: 1, hashValue: garbage(0) },
      { id: 2, hashValue: garbage(1) },
    ]

    const plan = planSplit(items)

    expect(plan.degenerate).toBe('single-group')
    expect(plan.groups).toEqual([{ kind: 'unidentified', itemIds: [1, 2] }])
  })

  it('partitions a mixed confident + ambiguous list into two groups, confident first', () => {
    const items = [
      { id: 1, hashValue: HEX32 },
      { id: 2, hashValue: SHA512_CRYPT },
    ]

    const plan = planSplit(items)

    expect(plan.degenerate).toBeNull()
    expect(plan.groups).toEqual([
      { kind: 'confident', mode: SHA512_CRYPT_MODE, itemIds: [2] },
      { kind: 'ambiguous', candidateModes: HEX32_SIGNATURE, itemIds: [1] },
    ])
  })

  it('dedupes identical hashValues within a destination group, keeping the first id', () => {
    const items = [
      { id: 1, hashValue: SHA512_CRYPT },
      { id: 2, hashValue: SHA512_CRYPT }, // duplicate value, same group
      { id: 3, hashValue: `$6$otherslt$${'B'.repeat(86)}` }, // distinct value, same group
    ]

    const plan = planSplit(items)

    // Still a single confident group -> degenerate, but the dedupe behavior
    // is what's under test here: id 2 is dropped, id 1 and 3 survive.
    expect(plan.groups).toEqual([{ kind: 'confident', mode: SHA512_CRYPT_MODE, itemIds: [1, 3] }])
  })

  it('orders groups deterministically: confident (by mode asc), then ambiguous (by signature asc), then unidentified', () => {
    const items = [
      { id: 1, hashValue: garbage(0) }, // unidentified
      { id: 2, hashValue: HEX32 }, // ambiguous [0,900,1000,3000]
      { id: 3, hashValue: `$6$saltsalt$${'C'.repeat(86)}` }, // confident 1800
      { id: 4, hashValue: '$2b$12$' + 'D'.repeat(53) }, // confident bcrypt 3200
    ]

    const plan = planSplit(items)

    expect(plan.degenerate).toBeNull()
    expect(plan.groups.map((g) => g.kind)).toEqual([
      'confident',
      'confident',
      'ambiguous',
      'unidentified',
    ])
    // Confident groups sorted by mode ascending: 1800 before 3200.
    expect(plan.groups[0]).toEqual({ kind: 'confident', mode: 1800, itemIds: [3] })
    expect(plan.groups[1]).toEqual({ kind: 'confident', mode: 3200, itemIds: [4] })
    expect(plan.groups[2]).toEqual({
      kind: 'ambiguous',
      candidateModes: HEX32_SIGNATURE,
      itemIds: [2],
    })
    expect(plan.groups[3]).toEqual({ kind: 'unidentified', itemIds: [1] })
  })
})
