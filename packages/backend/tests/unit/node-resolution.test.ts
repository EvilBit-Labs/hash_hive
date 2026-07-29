/**
 * Unit tests for the node-resolution layer (plan U5 / KTD7).
 *
 * Two concerns, both testable WITHOUT a live DB:
 *   - `resolveNodeToLeaves` for a #202 split parent — the DB read is behind
 *     the `_nodeResolutionDeps.fetchSplitParentLeaves` injectable seam
 *     (mirrors `_campaignSplitDeps`), so these tests stub it rather than
 *     hitting Postgres. The real one-level, project-scoped query is covered
 *     by the DB lane (mirrors `scope-helpers-parity.db.test.ts`).
 *   - `groupItemsByMode` — the pure "group union items by resolved hashcat
 *     mode" seam the #202 worker and (U10) the super fan-out share. Wraps
 *     the already-node-agnostic `planSplit`, so its degenerate signal is
 *     asserted to match what `planSplit` returns.
 *
 * The `kind: 'super'` resolution case is deliberately NOT unit-tested here:
 * it always reads live membership from `super_hash_list_members`, so there is
 * no DB-free seam to stub the way `fetchSplitParentLeaves` stubs the
 * split-parent case. Its coverage lives in the DB lane instead - see
 * `tests/db/super-campaign-fanout.db.test.ts`,
 * `tests/db/super-campaign-progress.db.test.ts`, and
 * `tests/db/super-remove-member-harvest.db.test.ts`, which all exercise
 * `resolveNodeToLeaves({ kind: 'super', ... })` against a real project.
 *
 * Design: no `IS_ISOLATED` gate needed — the only shared mutable state is the
 * `_nodeResolutionDeps` seam, restored in `afterEach`.
 *
 * Fixture note (verified against the real HASH_PATTERNS table): the three
 * confident fixtures are `$`-prefixed structured crypt formats, each a single
 * unambiguous candidate — SHA-512 Crypt (1800), bcrypt (3200), SHA-256 Crypt
 * (7400) — so no raw-hex pattern co-matches and each lands in its own mode.
 */

import { afterEach, describe, expect, it } from 'bun:test'

import {
  _nodeResolutionDeps,
  groupItemsByMode,
  type NodeDescriptor,
  resolveNodeToLeaves,
} from '../../src/services/hash-items/node-resolution/index.js'

// ─── Fixtures — three distinct confident modes ────────────────────────────────

/** SHA-512 Crypt (`$6$…`), single candidate, hashcatMode 1800. */
const SHA512_CRYPT = `$6$abcdefgh$${'A'.repeat(86)}`
const SHA512_CRYPT_MODE = 1800
/** bcrypt (`$2b$12$…`), single candidate, hashcatMode 3200. */
const BCRYPT = `$2b$12$${'D'.repeat(53)}`
const BCRYPT_MODE = 3200
/** SHA-256 Crypt (`$5$…`), single candidate, hashcatMode 7400. */
const SHA256_CRYPT = `$5$abcdefgh$${'A'.repeat(43)}`
const SHA256_CRYPT_MODE = 7400

// ─── resolveNodeToLeaves — #202 split parent ──────────────────────────────────

describe('resolveNodeToLeaves — #202 split parent', () => {
  const originalFetch = _nodeResolutionDeps.fetchSplitParentLeaves
  afterEach(() => {
    _nodeResolutionDeps.fetchSplitParentLeaves = originalFetch
  })

  it("returns the parent hash list's child leaf ids, passing (hashListId, projectId) through", async () => {
    const calls: Array<[number, number]> = []
    _nodeResolutionDeps.fetchSplitParentLeaves = async (hashListId, projectId) => {
      calls.push([hashListId, projectId])
      return [101, 102, 103]
    }

    const node: NodeDescriptor = { kind: 'split-parent', hashListId: 7, projectId: 3 }
    const leaves = await resolveNodeToLeaves(node)

    expect(leaves).toEqual([101, 102, 103])
    // Exactly one, project-scoped lookup against the parent id.
    expect(calls).toEqual([[7, 3]])
  })

  it('returns [] for a parent with no children (or a cross-project / missing id — IDOR guard)', async () => {
    _nodeResolutionDeps.fetchSplitParentLeaves = async () => []
    const leaves = await resolveNodeToLeaves({
      kind: 'split-parent',
      hashListId: 999,
      projectId: 1,
    })
    expect(leaves).toEqual([])
  })
})

// ─── groupItemsByMode — union across a node's leaves ──────────────────────────

describe('groupItemsByMode — group a leaf-item union by resolved mode', () => {
  it('partitions a union spanning three modes into three groups, and dedupes identical values within a group', () => {
    const items = [
      { id: 1, hashValue: SHA512_CRYPT },
      { id: 2, hashValue: SHA512_CRYPT }, // duplicate value → same group, deduped
      { id: 3, hashValue: BCRYPT },
      { id: 4, hashValue: SHA256_CRYPT },
    ]

    const grouping = groupItemsByMode(items)

    // Three distinct mode groups — a genuine multi-mode union, not degenerate.
    expect(grouping.degenerate).toBeNull()
    expect(grouping.groups).toHaveLength(3)
    expect(grouping.groups.every((g) => g.kind === 'confident')).toBe(true)

    // Ordered by mode ascending (confident kind).
    const modes = grouping.groups.map((g) => (g.kind === 'confident' ? g.mode : -1))
    expect(modes).toEqual([SHA512_CRYPT_MODE, BCRYPT_MODE, SHA256_CRYPT_MODE])

    // Within the SHA-512 group, the duplicate value (id 2) was dropped —
    // first id seen (1) survives.
    const sha512Group = grouping.groups.find(
      (g) => g.kind === 'confident' && g.mode === SHA512_CRYPT_MODE
    )
    expect(sha512Group?.itemIds).toEqual([1])
  })
})

describe('groupItemsByMode — degenerate signal mirrors planSplit', () => {
  it('a single-mode node surfaces the same "single-group" degenerate signal planSplit returns', () => {
    const grouping = groupItemsByMode([
      { id: 1, hashValue: SHA512_CRYPT },
      { id: 2, hashValue: `$6$otherslt$${'B'.repeat(86)}` },
    ])

    expect(grouping.degenerate).toBe('single-group')
    expect(grouping.groups).toHaveLength(1)
    expect(grouping.groups[0]?.kind).toBe('confident')
  })

  it('an empty union surfaces "empty"', () => {
    const grouping = groupItemsByMode([])
    expect(grouping.degenerate).toBe('empty')
    expect(grouping.groups).toEqual([])
  })
})
