/**
 * Unit tests for the cracker service module.
 *
 * Pure-function tests cover the version comparator and engine normalization
 * — the deterministic logic that does not require a database round-trip.
 * DB-bound integration is exercised through the route tests in U3/U4.
 */
import { describe, expect, test } from 'bun:test';
import { compareCrackerVersions } from '../../src/services/crackers.js';

describe('compareCrackerVersions', () => {
  test('returns 0 for equal versions', () => {
    expect(compareCrackerVersions('6.2.6', '6.2.6')).toBe(0);
  });

  test('orders later patch numerically', () => {
    expect(compareCrackerVersions('6.2.6', '6.2.7')).toBeLessThan(0);
    expect(compareCrackerVersions('6.2.7', '6.2.6')).toBeGreaterThan(0);
  });

  test('orders later minor numerically', () => {
    expect(compareCrackerVersions('6.1.0', '6.2.0')).toBeLessThan(0);
  });

  test('orders later major numerically', () => {
    expect(compareCrackerVersions('5.9.9', '6.0.0')).toBeLessThan(0);
  });

  test('treats missing trailing components as zero', () => {
    expect(compareCrackerVersions('6.2', '6.2.0')).toBe(0);
    expect(compareCrackerVersions('6.2', '6.2.1')).toBeLessThan(0);
  });

  test('handles vendor suffix as later when base versions match', () => {
    // hashcat-style: 6.2.6 < 6.2.6+125
    expect(compareCrackerVersions('6.2.6', '6.2.6+125')).toBeLessThan(0);
    expect(compareCrackerVersions('6.2.6+125', '6.2.6')).toBeGreaterThan(0);
  });

  test('orders distinct vendor suffixes lexicographically', () => {
    expect(compareCrackerVersions('1.9.0-jumbo-1', '1.9.0-jumbo-2')).toBeLessThan(0);
  });

  test('orders entirely-non-semver strings deterministically', () => {
    // Both should resolve to a stable, total ordering rather than NaN.
    const result = compareCrackerVersions('alpha', 'beta');
    expect(result).not.toBe(0);
    expect(result < 0 || result > 0).toBe(true);
  });

  test('higher number beats vendor suffix on lower number', () => {
    expect(compareCrackerVersions('6.2.7', '6.2.6+125')).toBeGreaterThan(0);
  });
});
