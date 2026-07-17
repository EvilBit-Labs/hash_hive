/**
 * Split-analysis helper for mixed hash-list partitioning (issue #202, unit SU2).
 *
 * Pure classification/grouping logic — no DB import, no module-scope side
 * effects — mirrors `hash-items/type-analysis.ts` so it loads without a live
 * DB connection and is trivially unit-testable. The worker
 * (`queue/workers/hash-list-split.ts`) is the only caller that touches the
 * database: it loads a parent hash list's items, calls `planSplit`, and
 * turns the resulting `SplitPlan` into real `hash_lists` rows + moved
 * `hash_items` rows.
 *
 * CROSS-UNIT CONTRACT (pinned — SU3/SU4 depend on this shape, do not change
 * without updating callers):
 *   - `classifyEntry` uses `guessHashType` (the full ranked-candidate list,
 *     not `guessTopHashType`'s single fast guess) because the whole point of
 *     this pass is to distinguish a genuinely unambiguous match (exactly one
 *     candidate) from a same-length collision (2+ candidates, e.g. any
 *     32-hex string matching NTLM/MD5/LM/MD4) — the wrong-auto-guess harm
 *     the ambiguous review step exists to prevent. Ambiguous NEVER
 *     auto-resolves to a single mode.
 *   - `planSplit` partitions items into one group per confident mode, one
 *     per ambiguous candidate-mode signature, and one for unidentified
 *     entries. Groups are deduped by identical `hashValue` within a group
 *     (keeps the first `id` seen) — defends the caller's unique
 *     `(hashListId, hashValue)` index against a same-value collision landing
 *     in one destination sub-list, even though a single hash list can never
 *     contain duplicate hashValues today (ingestion's `onConflictDoNothing`
 *     already enforces that at insert time).
 *   - `degenerate: 'empty'` when there are no items to classify;
 *     `degenerate: 'single-group'` when classification collapses to exactly
 *     one group (all-confident-same-mode, or every entry unidentified, or
 *     any other case where there is nothing to split). The caller must NOT
 *     create sub-lists in either degenerate case — a zero-child or
 *     single-child parent is never valid.
 */

import { guessHashType } from '../hash-analysis.js'

// ─── Classification ──────────────────────────────────────────────────────

export type GroupKind = 'confident' | 'ambiguous' | 'unidentified'

export type ClassifyResult =
  | { kind: 'confident'; mode: number }
  | { kind: 'ambiguous'; signature: number[] }
  | { kind: 'unidentified' }

/**
 * Minimum number of ranked candidates `guessHashType` must return before an
 * entry is treated as ambiguous rather than confidently resolved.
 */
const AMBIGUOUS_CANDIDATE_THRESHOLD = 2

/**
 * Classifies a single hash entry against `guessHashType`'s ranked candidate
 * list:
 *   - 0 candidates  -> unidentified
 *   - 1 candidate   -> confident, mode = that candidate's hashcatMode
 *   - 2+ candidates -> ambiguous, signature = sorted unique candidate modes
 */
export function classifyEntry(hashValue: string): ClassifyResult {
  const candidates = guessHashType(hashValue)

  if (candidates.length === 0) {
    return { kind: 'unidentified' }
  }

  if (candidates.length < AMBIGUOUS_CANDIDATE_THRESHOLD) {
    const only = candidates[0]
    if (only === undefined) {
      // Unreachable: the `=== 0` check above already handled the empty
      // case, so length is exactly 1 here — guard kept for type safety.
      return { kind: 'unidentified' }
    }
    return { kind: 'confident', mode: only.hashcatMode }
  }

  const signature = candidates.map((c) => c.hashcatMode).sort((a, b) => a - b)
  return { kind: 'ambiguous', signature }
}

// ─── Grouping ─────────────────────────────────────────────────────────────

export interface SplitItem {
  id: number
  hashValue: string
}

/**
 * One partition of the parent's items. `mode` is present only for
 * `kind: 'confident'`; `candidateModes` only for `kind: 'ambiguous'` —
 * mirrors the cross-unit contract's `{ kind, mode?, candidateModes?,
 * itemIds }` shape (optional fields, not a discriminated union) so SU3/SU4
 * can read the group generically without narrowing first.
 */
export interface SplitGroup {
  kind: GroupKind
  mode?: number
  candidateModes?: number[]
  itemIds: number[]
}

export type SplitDegenerateReason = 'single-group' | 'empty' | null

export interface SplitPlan {
  groups: SplitGroup[]
  degenerate: SplitDegenerateReason
}

/** Deterministic group ordering: confident, then ambiguous, then unidentified. */
const GROUP_KIND_ORDER: Record<GroupKind, number> = {
  confident: 0,
  ambiguous: 1,
  unidentified: 2,
}

/** Exactly one group after partitioning means there is nothing to split. */
const SINGLE_GROUP_COUNT = 1

function groupKey(classification: ClassifyResult): string {
  if (classification.kind === 'confident') {
    return `confident:${classification.mode}`
  }
  if (classification.kind === 'ambiguous') {
    return `ambiguous:${classification.signature.join(',')}`
  }
  return 'unidentified'
}

interface WorkingGroup {
  kind: GroupKind
  mode?: number
  candidateModes?: number[]
  itemIds: number[]
  seenHashValues: Set<string>
}

function compareGroups(a: SplitGroup, b: SplitGroup): number {
  const kindDiff = GROUP_KIND_ORDER[a.kind] - GROUP_KIND_ORDER[b.kind]
  if (kindDiff !== 0) return kindDiff

  if (a.kind === 'confident') {
    return (a.mode ?? 0) - (b.mode ?? 0)
  }

  if (a.kind === 'ambiguous') {
    const aSig = a.candidateModes ?? []
    const bSig = b.candidateModes ?? []
    const maxLen = Math.max(aSig.length, bSig.length)
    for (let i = 0; i < maxLen; i++) {
      const diff = (aSig[i] ?? 0) - (bSig[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }

  return 0
}

/**
 * Partitions a parent hash list's items into split groups. Pure: takes the
 * already-loaded `(id, hashValue)` rows and returns a plan; the caller
 * (the split worker) is responsible for turning that plan into real rows.
 */
export function planSplit(items: readonly SplitItem[]): SplitPlan {
  if (items.length === 0) {
    return { groups: [], degenerate: 'empty' }
  }

  const groups = new Map<string, WorkingGroup>()

  for (const item of items) {
    const classification = classifyEntry(item.hashValue)
    const key = groupKey(classification)

    let group = groups.get(key)
    if (!group) {
      group = { kind: classification.kind, itemIds: [], seenHashValues: new Set<string>() }
      if (classification.kind === 'confident') {
        group.mode = classification.mode
      } else if (classification.kind === 'ambiguous') {
        group.candidateModes = classification.signature
      }
      groups.set(key, group)
    }

    // Dedupe identical hashValues within a destination group — keep the
    // first id seen so the eventual reassign UPDATE can't violate the
    // caller's unique (hashListId, hashValue) index.
    if (group.seenHashValues.has(item.hashValue)) continue
    group.seenHashValues.add(item.hashValue)
    group.itemIds.push(item.id)
  }

  const orderedGroups = [...groups.values()]
    .map(({ kind, mode, candidateModes, itemIds }) => ({
      kind,
      ...(mode !== undefined ? { mode } : {}),
      ...(candidateModes !== undefined ? { candidateModes } : {}),
      itemIds,
    }))
    .sort(compareGroups)

  return {
    groups: orderedGroups,
    degenerate: orderedGroups.length === SINGLE_GROUP_COUNT ? 'single-group' : null,
  }
}
