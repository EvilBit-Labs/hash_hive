/**
 * Type-analysis helper for streaming hash-list ingestion (issue #202, unit FU3).
 *
 * Pure aggregation logic: turns a per-entry hashcat-mode histogram (accumulated
 * by the streaming parser via `guessTopHashType`) into the `HashListTypeAnalysis`
 * wire shape persisted to `hash_lists.type_analysis`. NO module-scope DB import —
 * mirrors `hash-items/import-parse.ts` so it loads without a live DB connection
 * and is trivially unit-testable.
 */

import type { HashListTypeAnalysis } from '@hashhive/shared'

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Hard cap on how many entries the streaming parser will run through
 * `guessTopHashType` per hash list. Beyond this, detection stops (the analysis
 * is marked `sampled: true`) but row insertion continues uninterrupted — this
 * bounds the per-line detection cost on very large uploads without capping
 * ingest throughput.
 */
export const TYPE_DETECTION_SCAN_CAP = 1_000_000

/**
 * Minimum share of scanned entries a detected hashcat mode must represent to
 * count as a real signal rather than noise (typos, corrupted lines, a handful
 * of stray hashes of a different type). A mode below this share still appears
 * in `detectedModes` for visibility, but does not by itself flip the verdict
 * to `mixed` or trigger a declared-mode mismatch.
 */
const NOISE_MIN_SHARE = 0.05

/**
 * Share of scanned entries that must be unidentified (no pattern match) before
 * the verdict is forced to `needs-review` regardless of how clean the
 * identified portion looks. At or above this share, the list has too much
 * unrecognized content to trust any homogeneous/mixed call.
 */
const UNIDENTIFIED_DOMINANCE_SHARE = 0.5

// ─── Verdict computation ────────────────────────────────────────────────────

/**
 * Builds the persisted `HashListTypeAnalysis` record from parser-accumulated
 * counters. Verdict precedence (evaluated in order, first match wins):
 *
 *   1. `scannedCount === 0`                     -> `homogeneous`, empty detectedModes
 *      (pinned default for an empty/undetected list — nothing to disagree about)
 *   2. unidentified share >= DOMINANCE_SHARE     -> `needs-review`
 *      (too much unrecognized content to trust any other verdict)
 *   3. 2+ modes each >= NOISE_MIN_SHARE          -> `mixed`
 *   4. exactly 1 mode >= NOISE_MIN_SHARE          -> `homogeneous`, unless a
 *      `declaredMode` is set and disagrees with that mode, in which case
 *      `needs-review` (declared-vs-detected mismatch)
 *   5. no mode clears the noise floor and unidentified doesn't dominate
 *      either (counts scattered thinly across many sub-noise modes) ->
 *      `needs-review` — nothing here is a strong enough signal to call
 *      homogeneous or mixed, so it's flagged for a human to look at.
 *
 * `detectedModes` always includes every mode seen in the histogram (including
 * below-noise entries), sorted by count descending, tie-broken by hashcatMode
 * ascending for deterministic output regardless of Map iteration order.
 *
 * `histogram` is read-only; this function never mutates it.
 */
export function buildTypeAnalysis(
  histogram: ReadonlyMap<number, number>,
  unidentifiedCount: number,
  scannedCount: number,
  sampled: boolean,
  declaredMode: number | null
): HashListTypeAnalysis {
  const analyzedAt = new Date().toISOString()

  if (scannedCount === 0) {
    return {
      verdict: 'homogeneous',
      detectedModes: [],
      unidentifiedCount,
      scannedCount,
      sampled,
      declaredMode,
      analyzedAt,
    }
  }

  const detectedModes = [...histogram.entries()]
    .map(([hashcatMode, count]) => ({ hashcatMode, count }))
    .sort((a, b) => b.count - a.count || a.hashcatMode - b.hashcatMode)

  const modesAboveNoise = detectedModes.filter(
    (mode) => mode.count / scannedCount >= NOISE_MIN_SHARE
  )
  const unidentifiedShare = unidentifiedCount / scannedCount

  const verdict = resolveVerdict(modesAboveNoise, unidentifiedShare, declaredMode)

  return {
    verdict,
    detectedModes,
    unidentifiedCount,
    scannedCount,
    sampled,
    declaredMode,
    analyzedAt,
  }
}

function resolveVerdict(
  modesAboveNoise: ReadonlyArray<{ hashcatMode: number; count: number }>,
  unidentifiedShare: number,
  declaredMode: number | null
): HashListTypeAnalysis['verdict'] {
  if (unidentifiedShare >= UNIDENTIFIED_DOMINANCE_SHARE) {
    return 'needs-review'
  }

  if (modesAboveNoise.length >= 2) {
    return 'mixed'
  }

  if (modesAboveNoise.length === 1) {
    const [topMode] = modesAboveNoise
    const declaredMismatch =
      declaredMode !== null && topMode !== undefined && topMode.hashcatMode !== declaredMode
    return declaredMismatch ? 'needs-review' : 'homogeneous'
  }

  // No mode clears the noise floor and unidentified doesn't dominate either.
  return 'needs-review'
}
