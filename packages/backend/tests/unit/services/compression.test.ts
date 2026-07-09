/**
 * Unit tests for the direct-upload gzip helper (issue #108 U3).
 *
 * Pure buffer-in/buffer-out logic — no DB, no storage — so this is a plain
 * unit test rather than a real-DB integration test (see
 * `tests/db/resource-upload-compression.db.test.ts` for the end-to-end
 * upload -> storage -> round-trip coverage).
 */
import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'

import { compressBufferForStorage } from '../../../src/services/resources/compression.js'

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

  test('incompressible (random) content falls back to none and the original buffer', () => {
    // crypto-random bytes have no exploitable redundancy; gzip cannot shrink
    // them and typically grows them slightly (header/trailer overhead).
    const random = Buffer.from(Array.from({ length: 2048 }, () => Math.floor(Math.random() * 256)))

    const result = compressBufferForStorage(random)

    expect(result.encoding).toBe('none')
    expect(result.bytes).toBe(random)
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
