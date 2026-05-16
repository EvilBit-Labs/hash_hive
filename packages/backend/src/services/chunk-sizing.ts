/**
 * Benchmark-aware chunk sizing for task generation and rebalancing.
 *
 * `pickChunkSize` is used at generation time and picks a chunk size based on
 * the median speed of the fleet's benchmarks for the attack's hashcat mode.
 * `pickRebalanceChunkSize` is used when an offline agent's stranded task is
 * being re-chunked and uses the claiming agent's own benchmark.
 *
 * Both helpers carry keyspace values as bigint-decimal strings to preserve
 * precision past `Number.MAX_SAFE_INTEGER`.
 *
 * Pure - no DB access, no I/O. Test in `tests/unit/chunk-sizing.test.ts`.
 */

/** Wall-time target per chunk. Roughly amortizes claim overhead while keeping
 *  the offline-loss window short. Fixed for now; tuning is a future issue. */
export const TARGET_CHUNK_SECONDS = 60;

/** Minimum chunk size - below this, claim overhead dominates work. */
export const MIN_CHUNK_SIZE = '1000';

/** Maximum chunk size - above this, an offline agent loses too much progress. */
export const MAX_CHUNK_SIZE = '1000000000';

/** Fallback chunk size when no fleet data is available - matches the legacy
 *  `DEFAULT_CHUNK_SIZE = 10_000_000` so a fresh fleet doesn't regress. */
export const FALLBACK_CHUNK_SIZE = '10000000';

interface Benchmark {
  readonly speedHs: number;
}

export interface PickChunkSizeInput {
  /** Total attack keyspace, bigint-decimal string. */
  totalKeyspace: string;
  /** Fleet benchmarks for the attack's hashcat mode. */
  benchmarks: ReadonlyArray<Benchmark>;
  /** Override wall-time target (testing knob). */
  targetSeconds?: number;
}

export interface PickRebalanceChunkSizeInput {
  /** Remaining keyspace of the stale task, bigint-decimal string. */
  remaining: string;
  /** The claiming agent's benchmark, or null if not benchmarked. */
  benchmark: Benchmark | null;
  /** Override wall-time target (testing knob). */
  targetSeconds?: number;
}

/**
 * Median of a non-empty list of benchmark speeds. Uses the standard
 * statistical convention: odd-length picks the middle, even-length
 * averages the two middle values.
 */
function medianSpeed(benchmarks: ReadonlyArray<Benchmark>): number {
  const sorted = [...benchmarks].map((b) => b.speedHs).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) throw new Error('medianSpeed called with empty benchmarks');
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sorted[mid] as number;
  }
  const left = sorted[mid - 1] as number;
  const right = sorted[mid] as number;
  return (left + right) / 2;
}

/**
 * Clamp a candidate chunk size to the policy bounds:
 *   - Never larger than the remaining/total keyspace (last chunk is partial).
 *   - Never larger than MAX_CHUNK_SIZE.
 *   - Never smaller than MIN_CHUNK_SIZE - unless the total itself is smaller,
 *     in which case the total wins (the whole keyspace fits in one chunk).
 */
function clampChunkSize(candidate: bigint, totalOrRemaining: bigint): bigint {
  const max = BigInt(MAX_CHUNK_SIZE);
  const min = BigInt(MIN_CHUNK_SIZE);

  let result = candidate;
  if (result > max) result = max;
  if (result < min) result = min;
  // If the total is below MIN, the whole keyspace fits in one chunk.
  if (totalOrRemaining < min) return totalOrRemaining;
  // Never exceed what's actually available.
  if (result > totalOrRemaining) return totalOrRemaining;
  return result;
}

export function pickChunkSize(input: PickChunkSizeInput): string {
  if (input.benchmarks.length === 0) {
    return FALLBACK_CHUNK_SIZE;
  }
  const target = input.targetSeconds ?? TARGET_CHUNK_SECONDS;
  const median = medianSpeed(input.benchmarks);
  // BigInt arithmetic; median may be fractional (even-length list) - round
  // to an integer before converting, since speed * time is integer keyspace.
  const candidate = BigInt(Math.floor(median * target));
  return clampChunkSize(candidate, BigInt(input.totalKeyspace)).toString();
}

export function pickRebalanceChunkSize(input: PickRebalanceChunkSizeInput): string {
  if (input.benchmark === null) {
    // Without a benchmark, the legacy fallback is the safest choice - but
    // still cap at remaining so we don't generate an over-sized chunk for
    // a tiny remainder.
    const fallback = BigInt(FALLBACK_CHUNK_SIZE);
    const remaining = BigInt(input.remaining);
    return (fallback > remaining ? remaining : fallback).toString();
  }
  const target = input.targetSeconds ?? TARGET_CHUNK_SECONDS;
  const candidate = BigInt(Math.floor(input.benchmark.speedHs * target));
  return clampChunkSize(candidate, BigInt(input.remaining)).toString();
}
