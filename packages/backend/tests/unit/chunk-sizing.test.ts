/**
 * Unit tests for benchmark-aware chunk sizing.
 *
 * Two pure helpers live here:
 *   - `pickChunkSize` - generation time, median of fleet benchmarks
 *   - `pickRebalanceChunkSize` - rebalance time, single claiming-agent benchmark
 *
 * Both return chunk sizes as bigint-decimal strings. Empty/missing
 * benchmarks fall back to FALLBACK_CHUNK_SIZE (matches today's
 * DEFAULT_CHUNK_SIZE = 10_000_000) so a fresh fleet doesn't regress.
 */
import { describe, expect, test } from 'bun:test';
import {
  FALLBACK_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  pickChunkSize,
  pickRebalanceChunkSize,
  TARGET_CHUNK_SECONDS,
} from '../../src/services/chunk-sizing.js';

describe('exported constants', () => {
  test('TARGET_CHUNK_SECONDS is 60', () => {
    expect(TARGET_CHUNK_SECONDS).toBe(60);
  });

  test('FALLBACK_CHUNK_SIZE matches the legacy 10M constant', () => {
    expect(FALLBACK_CHUNK_SIZE).toBe('10000000');
  });

  test('MIN_CHUNK_SIZE < MAX_CHUNK_SIZE', () => {
    expect(BigInt(MIN_CHUNK_SIZE)).toBeLessThan(BigInt(MAX_CHUNK_SIZE));
  });
});

describe('pickChunkSize', () => {
  test('empty benchmark fleet falls back to FALLBACK_CHUNK_SIZE', () => {
    expect(pickChunkSize({ totalKeyspace: '60000000000', benchmarks: [] })).toBe(
      FALLBACK_CHUNK_SIZE
    );
  });

  test('single benchmark - chunk = speedHs * targetSeconds, clamped at MAX', () => {
    // 100 MH/s * 60s = 6 GH -> clamped to MAX_CHUNK_SIZE (1 GH).
    const out = pickChunkSize({
      totalKeyspace: '60000000000',
      benchmarks: [{ speedHs: 100_000_000 }],
    });
    expect(out).toBe(MAX_CHUNK_SIZE);
  });

  test('three benchmarks - median picks middle value', () => {
    // Median of [1e6, 1e8, 1e10] = 1e8 -> 1e8*60 = 6e9 -> clamped to MAX (1e9).
    const out = pickChunkSize({
      totalKeyspace: '60000000000',
      benchmarks: [{ speedHs: 1_000_000 }, { speedHs: 100_000_000 }, { speedHs: 10_000_000_000 }],
    });
    expect(out).toBe(MAX_CHUNK_SIZE);
  });

  test('odd-length median is the middle value', () => {
    // Median of [10, 20, 30, 40, 50] (sorted) = 30.
    // 30 * 60 = 1800 -> below MIN (1000) -> returns MIN_CHUNK_SIZE.
    const out = pickChunkSize({
      totalKeyspace: '1000000000',
      benchmarks: [
        { speedHs: 30 },
        { speedHs: 10 },
        { speedHs: 50 },
        { speedHs: 20 },
        { speedHs: 40 },
      ],
    });
    // 30*60 = 1800 - between MIN and MAX, not clamped.
    expect(out).toBe('1800');
  });

  test('even-length median averages the two middle values', () => {
    // [10, 20, 30, 40] -> median = (20+30)/2 = 25 -> 25*60 = 1500.
    const out = pickChunkSize({
      totalKeyspace: '1000000000',
      benchmarks: [{ speedHs: 10 }, { speedHs: 20 }, { speedHs: 30 }, { speedHs: 40 }],
    });
    expect(out).toBe('1500');
  });

  test('tiny totalKeyspace is the final cap', () => {
    // 100MH/s * 60s = 6GH, but only 500 units to crack -> returns 500.
    const out = pickChunkSize({
      totalKeyspace: '500',
      benchmarks: [{ speedHs: 100_000_000 }],
    });
    expect(out).toBe('500');
  });

  test('benchmark below MIN floor still clamps to MIN when total >= MIN', () => {
    // speedHs=1, target=60 -> 60 (below MIN 1000) -> clamped to MIN.
    const out = pickChunkSize({
      totalKeyspace: '100000',
      benchmarks: [{ speedHs: 1 }],
    });
    expect(out).toBe(MIN_CHUNK_SIZE);
  });

  test('honors custom targetSeconds', () => {
    // 1000H/s * 10s = 10000.
    const out = pickChunkSize({
      totalKeyspace: '1000000000',
      benchmarks: [{ speedHs: 1000 }],
      targetSeconds: 10,
    });
    expect(out).toBe('10000');
  });

  test('bigint-keyspace input does not overflow JS numbers', () => {
    // 10^20 keyspace, 100MH/s fleet -> chunk should be MAX.
    const out = pickChunkSize({
      totalKeyspace: '100000000000000000000',
      benchmarks: [{ speedHs: 100_000_000 }],
    });
    expect(out).toBe(MAX_CHUNK_SIZE);
  });
});

describe('pickRebalanceChunkSize', () => {
  test('null benchmark falls back to FALLBACK_CHUNK_SIZE', () => {
    expect(pickRebalanceChunkSize({ remaining: '6000000000', benchmark: null })).toBe(
      FALLBACK_CHUNK_SIZE
    );
  });

  test('uses the supplied benchmark directly (no median)', () => {
    // 1MH/s * 60s = 60M.
    expect(
      pickRebalanceChunkSize({ remaining: '1000000000', benchmark: { speedHs: 1_000_000 } })
    ).toBe('60000000');
  });

  test('clamps to MAX when speed * target overflows MAX', () => {
    expect(
      pickRebalanceChunkSize({
        remaining: '10000000000',
        benchmark: { speedHs: 100_000_000_000 },
      })
    ).toBe(MAX_CHUNK_SIZE);
  });

  test('clamps to remaining when remaining is the smallest cap', () => {
    expect(
      pickRebalanceChunkSize({ remaining: '500', benchmark: { speedHs: 1_000_000_000 } })
    ).toBe('500');
  });

  test('clamps to MIN when speed * target < MIN', () => {
    expect(pickRebalanceChunkSize({ remaining: '100000', benchmark: { speedHs: 1 } })).toBe(
      MIN_CHUNK_SIZE
    );
  });

  test('honors custom targetSeconds', () => {
    expect(
      pickRebalanceChunkSize({
        remaining: '1000000000',
        benchmark: { speedHs: 1000 },
        targetSeconds: 10,
      })
    ).toBe('10000');
  });
});
