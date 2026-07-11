/**
 * Unit tests for the direct-upload gzip helper (issue #108 U3).
 *
 * Pure buffer-in/buffer-out logic — no DB, no storage — so this is a plain
 * unit test rather than a real-DB integration test (see
 * `tests/unit/services/resources-upload.test.ts` for the end-to-end
 * upload -> compression -> persisted-row coverage, mocking the storage
 * boundary since CI's real-DB lane has no object store to hit).
 */
import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'

import { compressBufferForStorage } from '../../../src/services/resources/compression.js'

const XORSHIFT_SEED = 0x9e3779b9

/**
 * Deterministic high-entropy byte stream (xorshift32, fixed seed) for
 * exercising the gzip-fallback path. Unlike `Math.random()`, this always
 * produces the exact same bytes, so the resulting `encoding: 'none'`
 * assertion below can't flake on a rare compressible draw.
 */
function deterministicIncompressibleBuffer(length: number): Buffer {
  let state = XORSHIFT_SEED
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    bytes[i] = state & 0xff
  }
  return Buffer.from(bytes)
}

describe('compressBufferForStorage', () => {
  test('compressible text is stored as gzip, strictly smaller than the input', () => {
    // Long, highly repetitive text compresses well under gzip.
    const original = Buffer.from(
      'the quick brown fox jumps over the lazy dog\n'.repeat(500),
      'utf8'
    )

    const result = compressBufferForStorage(original)

    expect(result.encoding).toBe('gzip')
    expect(result.bytes.length).toBeLessThan(original.length)
  })

  test('gzip output round-trips to the exact original bytes', () => {
    const original = Buffer.from('alpha\nbravo\ncharlie\n'.repeat(200), 'utf8')

    const { bytes, encoding } = compressBufferForStorage(original)

    expect(encoding).toBe('gzip')
    expect(gunzipSync(bytes)).toEqual(original)
  })

  test('incompressible (deterministic high-entropy) content falls back to none and the original buffer', () => {
    // A fixed xorshift32 stream has no exploitable redundancy, so gzip cannot
    // shrink it and typically grows it slightly (header/trailer overhead).
    // Deterministic (seeded, not Math.random()) so the test can't flake on a
    // rare compressible draw or a change to gzip's default settings.
    const incompressible = deterministicIncompressibleBuffer(2048)

    const result = compressBufferForStorage(incompressible)

    expect(result.encoding).toBe('none')
    expect(result.bytes).toBe(incompressible)
  })

  test('a tiny input whose gzip overhead exceeds its size falls back to none', () => {
    const tiny = Buffer.from('a', 'utf8')

    const result = compressBufferForStorage(tiny)

    expect(result.encoding).toBe('none')
    expect(result.bytes).toBe(tiny)
  })

  test('an empty buffer falls back to none', () => {
    const empty = Buffer.alloc(0)

    const result = compressBufferForStorage(empty)

    expect(result.encoding).toBe('none')
    expect(result.bytes).toBe(empty)
  })
})
