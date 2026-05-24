/**
 * Unit tests for the cracker service module.
 *
 * Pure-function tests cover the version comparator, engine normalization,
 * known-engine detection, and unique-violation detection — all the
 * deterministic logic that does not require a database round-trip. The
 * `getLatestCracker` selection algorithm is exercised by sorting fixture
 * arrays through the comparator with the same `(b, a)` argument order
 * the service uses; the DB query itself is covered in route contract tests.
 */
import { describe, expect, test } from 'bun:test'

import {
  compareCrackerVersions,
  isKnownEngine,
  isUniqueViolation,
  normalizeEngineName,
} from '../../src/services/crackers.js'

describe('compareCrackerVersions', () => {
  test('returns 0 for equal versions', () => {
    expect(compareCrackerVersions('6.2.6', '6.2.6')).toBe(0)
  })

  test('orders later patch numerically', () => {
    expect(compareCrackerVersions('6.2.6', '6.2.7')).toBeLessThan(0)
    expect(compareCrackerVersions('6.2.7', '6.2.6')).toBeGreaterThan(0)
  })

  test('orders later minor numerically', () => {
    expect(compareCrackerVersions('6.1.0', '6.2.0')).toBeLessThan(0)
  })

  test('orders later major numerically', () => {
    expect(compareCrackerVersions('5.9.9', '6.0.0')).toBeLessThan(0)
  })

  test('treats missing trailing components as zero', () => {
    expect(compareCrackerVersions('6.2', '6.2.0')).toBe(0)
    expect(compareCrackerVersions('6.2', '6.2.1')).toBeLessThan(0)
  })

  test('handles vendor suffix as later when base versions match', () => {
    // hashcat-style: 6.2.6 < 6.2.6+125
    expect(compareCrackerVersions('6.2.6', '6.2.6+125')).toBeLessThan(0)
    expect(compareCrackerVersions('6.2.6+125', '6.2.6')).toBeGreaterThan(0)
  })

  test('orders distinct vendor suffixes lexicographically', () => {
    expect(compareCrackerVersions('1.9.0-jumbo-1', '1.9.0-jumbo-2')).toBeLessThan(0)
  })

  test('orders entirely-non-semver strings deterministically', () => {
    // Both should resolve to a stable, total ordering rather than NaN.
    const result = compareCrackerVersions('alpha', 'beta')
    expect(result).not.toBe(0)
    expect(Number.isFinite(result)).toBe(true)
  })

  test('higher number beats vendor suffix on lower number', () => {
    expect(compareCrackerVersions('6.2.7', '6.2.6+125')).toBeGreaterThan(0)
  })

  test('parser edge: trailing dot is moved to suffix, not consumed as numeric', () => {
    // '6.2.' should parse as nums=[6,2], suffix='.'. Compared against '6.2'
    // (nums=[6,2], suffix=''), the empty-suffix wins per the comparator's
    // tiebreak policy.
    expect(compareCrackerVersions('6.2', '6.2.')).toBeLessThan(0)
    expect(compareCrackerVersions('6.2.', '6.2')).toBeGreaterThan(0)
  })

  test('parser edge: non-digit suffix after a numeric dot does not bleed into nums', () => {
    // '6.2.6.beta' must parse the numeric prefix as [6,2,6] with '.beta' as
    // suffix; the comparator should rank '6.2.6.beta' above plain '6.2.6'
    // because non-empty suffixes lose tiebreaks (`if pa.rest === '' return -1`).
    expect(compareCrackerVersions('6.2.6', '6.2.6.beta')).toBeLessThan(0)
  })

  test('parser edge: leading zeros do not alter numeric ordering', () => {
    expect(compareCrackerVersions('06.02', '6.2')).toBe(0)
    expect(compareCrackerVersions('06.02', '6.3')).toBeLessThan(0)
  })

  test('reverse-argument sort produces highest-version-first ordering', () => {
    // This mirrors getLatestCracker: rows.sort((a, b) => compareCrackerVersions(b.version, a.version)).
    // A regression that swapped the argument order would always return the oldest binary.
    const versions = ['6.2.5', '6.2.6+125', '6.2.6', '6.2.7']
    const sorted = [...versions].sort((a, b) => compareCrackerVersions(b, a))
    expect(sorted[0]).toBe('6.2.7')
    expect(sorted[sorted.length - 1]).toBe('6.2.5')
  })
})

describe('normalizeEngineName', () => {
  test('lowercases engine names so case cannot bypass uniqueness', () => {
    expect(normalizeEngineName('Hashcat')).toBe('hashcat')
    expect(normalizeEngineName('HASHCAT')).toBe('hashcat')
  })

  test('trims surrounding whitespace', () => {
    expect(normalizeEngineName('  hashcat  ')).toBe('hashcat')
    expect(normalizeEngineName('\thashcat\n')).toBe('hashcat')
  })

  test('defaults missing input to hashcat', () => {
    expect(normalizeEngineName(undefined)).toBe('hashcat')
    expect(normalizeEngineName(null)).toBe('hashcat')
    expect(normalizeEngineName('')).toBe('hashcat')
    expect(normalizeEngineName('   ')).toBe('hashcat')
  })

  test('passes through other valid engine names lowercased', () => {
    expect(normalizeEngineName('john')).toBe('john')
    expect(normalizeEngineName('John')).toBe('john')
  })
})

describe('isKnownEngine', () => {
  test('accepts the registered engines', () => {
    expect(isKnownEngine('hashcat')).toBe(true)
    expect(isKnownEngine('john')).toBe(true)
  })

  test('rejects unknown / typo engines', () => {
    expect(isKnownEngine('hashca')).toBe(false)
    expect(isKnownEngine('Hashcat')).toBe(false) // case-sensitive — caller should normalize first
    expect(isKnownEngine('')).toBe(false)
  })
})

describe('isUniqueViolation', () => {
  test('detects postgres unique-violation by typed code', () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' })
    expect(isUniqueViolation(err)).toBe(true)
  })

  test('returns false for non-unique-violation errors', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
    expect(isUniqueViolation({ code: '42P01' })).toBe(false) // undefined_table
    expect(isUniqueViolation('string error')).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  test('handles plain objects with the right code', () => {
    expect(isUniqueViolation({ code: '23505', message: 'whatever' })).toBe(true)
  })
})
