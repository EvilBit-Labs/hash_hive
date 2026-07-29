/**
 * Unit tests for the type-analysis helper (issue #202, unit FU3).
 *
 * Design: pure aggregation function; no DB connection, no mock.module, no
 * IS_ISOLATED env gate. Runs in the shared `bun test` phase (mirrors
 * tests/unit/services/import-parse.test.ts).
 *
 * Scenarios covered:
 *   1. single mode, zero unidentified          -> homogeneous, one detectedModes entry
 *   2. two modes each above noise               -> mixed, both present sorted desc
 *   3. one dominant + below-threshold outlier    -> homogeneous, outlier still listed
 *   4. high unidentified share                   -> needs-review
 *   5. declaredMode set, top detected differs    -> needs-review
 *   6. declaredMode set, top detected matches    -> homogeneous
 *   7. sampled flag propagates                   -> true and false both pass through
 *   8. empty (scannedCount 0)                    -> pinned homogeneous, empty detectedModes
 *   9. no mode clears noise, unidentified doesn't dominate -> needs-review (residual case)
 *  10. tie-broken sort                           -> equal counts sorted by hashcatMode asc
 */

import { describe, expect, it } from 'bun:test'

import {
  TYPE_DETECTION_SCAN_CAP,
  buildTypeAnalysis,
} from '../../../src/services/hash-items/type-analysis.js'

describe('TYPE_DETECTION_SCAN_CAP', () => {
  it('is a fixed 1,000,000 entry cap', () => {
    expect(TYPE_DETECTION_SCAN_CAP).toBe(1_000_000)
  })
})

describe('buildTypeAnalysis', () => {
  it('returns homogeneous with one detectedModes entry for a single clean mode', () => {
    // Arrange
    const histogram = new Map([[0, 100]])

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, null)

    // Assert
    expect(result.verdict).toBe('homogeneous')
    expect(result.detectedModes).toEqual([{ hashcatMode: 0, count: 100 }])
    expect(result.unidentifiedCount).toBe(0)
    expect(result.scannedCount).toBe(100)
    expect(result.sampled).toBe(false)
    expect(result.declaredMode).toBeNull()
    expect(typeof result.analyzedAt).toBe('string')
    expect(Number.isNaN(Date.parse(result.analyzedAt))).toBe(false)
  })

  it('returns mixed with both modes present sorted by count descending', () => {
    // Arrange
    const histogram = new Map([
      [0, 40],
      [1000, 60],
    ])

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, null)

    // Assert
    expect(result.verdict).toBe('mixed')
    expect(result.detectedModes).toEqual([
      { hashcatMode: 1000, count: 60 },
      { hashcatMode: 0, count: 40 },
    ])
  })

  it('stays homogeneous when a second mode is below the noise threshold, but still lists it', () => {
    // Arrange: dominant mode at 97/100, outlier at 3/100 (3% < 5% noise floor)
    const histogram = new Map([
      [0, 97],
      [1000, 3],
    ])

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, null)

    // Assert
    expect(result.verdict).toBe('homogeneous')
    expect(result.detectedModes).toEqual([
      { hashcatMode: 0, count: 97 },
      { hashcatMode: 1000, count: 3 },
    ])
  })

  it('returns needs-review when unidentified entries dominate the scan', () => {
    // Arrange: 60/100 unidentified (>= 50% dominance share)
    const histogram = new Map([[0, 40]])

    // Act
    const result = buildTypeAnalysis(histogram, 60, 100, false, null)

    // Assert
    expect(result.verdict).toBe('needs-review')
    expect(result.unidentifiedCount).toBe(60)
  })

  it('returns needs-review when the declared mode disagrees with the single detected mode', () => {
    // Arrange: list declares MD5 (0) but every scanned entry looks like NTLM (1000)
    const histogram = new Map([[1000, 100]])

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, 0)

    // Assert
    expect(result.verdict).toBe('needs-review')
    expect(result.declaredMode).toBe(0)
  })

  it('returns homogeneous when the declared mode matches the single detected mode', () => {
    // Arrange
    const histogram = new Map([[0, 100]])

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, 0)

    // Assert
    expect(result.verdict).toBe('homogeneous')
  })

  it('propagates the sampled flag unchanged in both directions', () => {
    // Arrange
    const histogram = new Map([[0, 100]])

    // Act
    const sampledTrue = buildTypeAnalysis(histogram, 0, 100, true, null)
    const sampledFalse = buildTypeAnalysis(histogram, 0, 100, false, null)

    // Assert
    expect(sampledTrue.sampled).toBe(true)
    expect(sampledFalse.sampled).toBe(false)
  })

  it('pins homogeneous with empty detectedModes for an empty scan', () => {
    // Arrange
    const histogram = new Map<number, number>()

    // Act
    const result = buildTypeAnalysis(histogram, 0, 0, false, null)

    // Assert
    expect(result.verdict).toBe('homogeneous')
    expect(result.detectedModes).toEqual([])
    expect(result.scannedCount).toBe(0)
    expect(result.unidentifiedCount).toBe(0)
  })

  it('returns needs-review when counts are scattered thin across many sub-noise modes', () => {
    // Arrange: 100 modes at 1 count each (1% share, below the 5% noise floor),
    // no unidentified entries (so the dominance rule does not fire either).
    const histogram = new Map(Array.from({ length: 100 }, (_, i) => [i, 1] as [number, number]))

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, null)

    // Assert
    expect(result.verdict).toBe('needs-review')
    expect(result.detectedModes).toHaveLength(100)
  })

  it('tie-breaks equal counts by hashcatMode ascending for deterministic output', () => {
    // Arrange
    const histogram = new Map([
      [1000, 50],
      [0, 50],
    ])

    // Act
    const result = buildTypeAnalysis(histogram, 0, 100, false, null)

    // Assert
    expect(result.detectedModes).toEqual([
      { hashcatMode: 0, count: 50 },
      { hashcatMode: 1000, count: 50 },
    ])
  })
})
