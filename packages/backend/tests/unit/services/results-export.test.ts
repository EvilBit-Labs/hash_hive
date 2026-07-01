/**
 * Unit tests for the results export service (issue #102, unit U3).
 *
 * Design: the service accepts injectable batch-fetchers and a skip-counter
 * so that every scenario here runs without a real database connection.
 * No mock.module, no IS_ISOLATED env gate — tests run in the shared phase.
 *
 * Scenarios covered:
 *   1. escapeCsv round-trip: attacker-controlled plaintext with commas,
 *      quotes, and leading formula triggers survives byte-for-byte.
 *   2. Salted-mode potfile (KTD5): stored hashValue contains `hash:salt`;
 *      export line is `hashValue:plaintext` with no reconstruction.
 *   3. cracked-pairs CSV includes username/source; plaintext-only omits
 *      hash value and account columns.
 *   4. uncracked variant: cursor-paginated, multi-batch; emits CSV header
 *      then all hash values in order.
 *   5. Potfile with unset hashTypeId: rows skipped, skippedCount returned
 *      before stream opens.
 *   6. exportQuerySchema rejects potfile format + csv-only variant.
 *   7. John potfile: known modes produce tagged lines; unknown mode skips.
 */

import { exportQuerySchema } from '@hashhive/shared'
import { describe, expect, it } from 'bun:test'

import {
  EXPORT_CSV_HEADERS,
  JOHN_FORMAT_TAGS,
  createExport,
  encodeCrackedRow,
  encodeUncrackedRow,
  escapeCsv,
  isEmittable,
} from '../../../src/services/results/export.js'

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Drain an AsyncGenerator into an array of strings. */
async function drainGenerator(gen: AsyncGenerator<string>): Promise<string[]> {
  const lines: string[] = []
  for await (const line of gen) {
    lines.push(line)
  }
  return lines
}

/** Minimal CrackedBatchRow factory — only required fields need values. */
function makeCrackedRow(
  overrides: Partial<{
    id: number
    hashValue: string
    plaintext: string | null
    crackedAt: Date | null
    username: string | null
    source: string | null
    hashListName: string | null
    campaignName: string | null
    attackMode: number | null
    hashcatMode: number | null
  }> = {}
) {
  return {
    id: 1,
    hashValue: 'abc123',
    plaintext: 'password',
    crackedAt: new Date('2024-01-15T12:00:00Z'),
    username: null,
    source: null,
    hashListName: 'my-list',
    campaignName: null,
    attackMode: null,
    hashcatMode: 0,
    ...overrides,
  } as const
}

// A typed null db for calls that use overrides for all DB access.
const NULL_DB = null as unknown as Parameters<typeof createExport>[0]

// ─── 1. escapeCsv round-trip ────────────────────────────────────────────────────

describe('escapeCsv', () => {
  it('encodes plaintext with commas, quotes, and formula trigger byte-for-byte', () => {
    // Arrange
    const raw = 'p@ss:w,ord"1'

    // Act
    const encoded = escapeCsv(raw)

    // Assert — decode: strip outer quotes, un-double inner quotes
    const inner = encoded.slice(1, -1).replace(/""/g, '"')
    expect(inner).toBe(raw)
  })

  it('prefixes leading = with apostrophe (formula injection guard)', () => {
    expect(escapeCsv('=cmd|calc')).toMatch(/^'=/)
  })

  it('prefixes leading + with apostrophe', () => {
    expect(escapeCsv('+malicious')).toMatch(/^'\+/)
  })

  it('returns empty string for null', () => {
    expect(escapeCsv(null)).toBe('')
  })

  it('returns value unchanged when no special chars', () => {
    expect(escapeCsv('plaintext')).toBe('plaintext')
  })
})

// ─── 2. Salted-mode potfile (KTD5) ────────────────────────────────────────────

describe('encodeCrackedRow — hashcat-potfile', () => {
  it('emits hashValue:plaintext for salted mode (hashValue contains hash:salt)', () => {
    // Arrange — mode 10 (md5($salt.$pass), hashValue = 'abc123:mysalt')
    const row = makeCrackedRow({
      hashValue: 'abc123:mysalt',
      plaintext: 'password',
      hashcatMode: 10,
    })

    // Act
    const line = encodeCrackedRow(row, 'cracked-pairs', 'hashcat-potfile')

    // Assert — full stored hashValue then colon then plaintext, no reconstruction
    expect(line).toBe('abc123:mysalt:password')
  })

  it('handles plaintext containing a colon', () => {
    // Proves we append plaintext verbatim rather than splitting on the last colon
    const row = makeCrackedRow({
      hashValue: 'deadbeef',
      plaintext: 'pass:word',
      hashcatMode: 0,
    })
    const line = encodeCrackedRow(row, 'cracked-pairs', 'hashcat-potfile')
    expect(line).toBe('deadbeef:pass:word')
  })

  it('returns null for a row whose hashType is unset (hashcatMode null)', () => {
    const row = makeCrackedRow({ hashcatMode: null })
    expect(encodeCrackedRow(row, 'cracked-pairs', 'hashcat-potfile')).toBeNull()
  })
})

// ─── 3. CSV variant column sets ────────────────────────────────────────────────

describe('encodeCrackedRow — csv', () => {
  it('cracked-pairs includes hash_value, plaintext, username, source', () => {
    // Arrange
    const row = makeCrackedRow({
      hashValue: 'deadbeef',
      plaintext: 'secret',
      username: 'admin',
      source: 'upload',
      hashListName: 'list1',
      campaignName: 'camp1',
      attackMode: 0,
      crackedAt: new Date('2024-06-01T00:00:00Z'),
      hashcatMode: 0,
    })

    // Act
    const line = encodeCrackedRow(row, 'cracked-pairs', 'csv')!
    const cells = line.split(',')

    // Assert — first 4 columns are hash_value, plaintext, username, source
    expect(cells[0]).toBe('deadbeef')
    expect(cells[1]).toBe('secret')
    expect(cells[2]).toBe('admin')
    expect(cells[3]).toBe('upload')
  })

  it('plaintext-only emits only the plaintext cell', () => {
    const row = makeCrackedRow({ plaintext: 'my-password', hashcatMode: 0 })
    expect(encodeCrackedRow(row, 'plaintext-only', 'csv')).toBe('my-password')
  })

  it('plaintext-only CSV is always emittable regardless of hashcatMode', () => {
    const row = makeCrackedRow({ hashcatMode: null, plaintext: 'pw' })
    expect(encodeCrackedRow(row, 'plaintext-only', 'csv')).toBe('pw')
  })
})

// ─── 4. Uncracked variant — multi-batch cursor pagination ──────────────────────

describe('createExport — uncracked variant', () => {
  it('emits CSV header then all hash values across multiple batches', async () => {
    // Arrange: batch fetcher yields 2 rows, then 1 row, then empty (done)
    const batches = [
      [
        { id: 10, hashValue: 'hash10' },
        { id: 9, hashValue: 'hash9' },
      ],
      [{ id: 8, hashValue: 'hash8' }],
      [],
    ] as const

    let callIndex = 0
    const cursors: Array<{ id: number } | null> = []

    const fakeUncrackedFetcher = async (cursor: { id: number } | null) => {
      cursors.push(cursor)
      return batches[callIndex++] ?? []
    }

    // Act
    const { skippedCount, rows } = await createExport(
      NULL_DB,
      { scope: 'project', projectId: 1, variant: 'uncracked', format: 'csv' },
      { batchSize: 2, fetchUncrackedBatch: fakeUncrackedFetcher }
    )
    const lines = await drainGenerator(rows)

    // Assert
    expect(skippedCount).toBe(0)
    expect(lines[0]).toBe(EXPORT_CSV_HEADERS.uncracked)
    expect(lines.slice(1)).toEqual(['hash10', 'hash9', 'hash8'])

    // Verify cursor is passed correctly between batches
    expect(cursors[0]).toBeNull() // first call has no cursor
    expect(cursors[1]).toEqual({ id: 9 }) // cursor = last row id of batch 1
    expect(cursors[2]).toEqual({ id: 8 }) // cursor = last row id of batch 2
  })
})

// ─── 5. Potfile with unset hashTypeId — skip + count ───────────────────────────

describe('createExport — skippedCount', () => {
  it('resolves skippedCount from countSkipped before stream opens', async () => {
    // Arrange
    const fakeCountSkipped = async () => 3
    const fakeFetch = async () => [] // no rows to stream

    // Act
    const { skippedCount, rows } = await createExport(
      NULL_DB,
      { scope: 'project', projectId: 1, variant: 'cracked-pairs', format: 'hashcat-potfile' },
      { countSkipped: fakeCountSkipped, fetchCrackedBatch: fakeFetch }
    )
    // skippedCount must be available BEFORE draining the stream
    expect(skippedCount).toBe(3)

    // Stream should still be usable afterward
    const lines = await drainGenerator(rows)
    expect(lines).toEqual([]) // no rows, no header for potfile
  })

  it('skippedCount is always 0 for CSV format', async () => {
    const fakeCountSkipped = async () => 999 // should not be called
    const fakeFetch = async () => []

    const { skippedCount } = await createExport(
      NULL_DB,
      { scope: 'project', projectId: 1, variant: 'cracked-pairs', format: 'csv' },
      { countSkipped: fakeCountSkipped, fetchCrackedBatch: fakeFetch }
    )
    // CSV never skips; countSkipped override should not be called
    expect(skippedCount).toBe(0)
  })

  it('skippedCount is 0 for uncracked variant (potfile not supported anyway)', async () => {
    const fakeCountSkipped = async () => 999

    const { skippedCount } = await createExport(
      NULL_DB,
      { scope: 'project', projectId: 1, variant: 'uncracked', format: 'csv' },
      { countSkipped: fakeCountSkipped, fetchUncrackedBatch: async () => [] }
    )
    expect(skippedCount).toBe(0)
  })
})

// ─── 6. Schema rejects potfile + csv-only variant ──────────────────────────────

describe('exportQuerySchema validation', () => {
  it('rejects hashcat-potfile with plaintext-only variant', () => {
    const result = exportQuerySchema.safeParse({
      scope: 'hash-list',
      variant: 'plaintext-only',
      format: 'hashcat-potfile',
    })
    expect(result.success).toBe(false)
  })

  it('rejects john-potfile with uncracked variant', () => {
    const result = exportQuerySchema.safeParse({
      scope: 'project',
      variant: 'uncracked',
      format: 'john-potfile',
    })
    expect(result.success).toBe(false)
  })

  it('rejects hashcat-potfile with uncracked variant', () => {
    const result = exportQuerySchema.safeParse({
      scope: 'campaign',
      variant: 'uncracked',
      format: 'hashcat-potfile',
    })
    expect(result.success).toBe(false)
  })

  it('accepts cracked-pairs with hashcat-potfile', () => {
    const result = exportQuerySchema.safeParse({
      scope: 'hash-list',
      variant: 'cracked-pairs',
      format: 'hashcat-potfile',
    })
    expect(result.success).toBe(true)
  })

  it('accepts plaintext-only with csv', () => {
    const result = exportQuerySchema.safeParse({
      scope: 'project',
      variant: 'plaintext-only',
      format: 'csv',
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown extra keys (strict mode)', () => {
    const result = exportQuerySchema.safeParse({
      scope: 'project',
      variant: 'cracked-pairs',
      format: 'csv',
      unknown: 'field',
    })
    expect(result.success).toBe(false)
  })
})

// ─── 7. John potfile tag lookup ─────────────────────────────────────────────────

describe('john-potfile encoding', () => {
  it('mode 0 (MD5) produces $dynamic_0$ prefix', () => {
    const row = makeCrackedRow({ hashValue: 'md5hash', plaintext: 'pw', hashcatMode: 0 })
    const line = encodeCrackedRow(row, 'cracked-pairs', 'john-potfile')
    expect(line).toBe(`${JOHN_FORMAT_TAGS[0]}md5hash:pw`)
  })

  it('mode 1000 (NTLM) produces $NT$ prefix', () => {
    const row = makeCrackedRow({ hashValue: 'ntlmhash', plaintext: 'pw', hashcatMode: 1000 })
    const line = encodeCrackedRow(row, 'cracked-pairs', 'john-potfile')
    expect(line).toBe(`${JOHN_FORMAT_TAGS[1000]}ntlmhash:pw`)
  })

  it('unmapped mode (500 / md5crypt) returns null (skipped)', () => {
    const row = makeCrackedRow({ hashValue: '$1$salt$hash', plaintext: 'pw', hashcatMode: 500 })
    expect(encodeCrackedRow(row, 'cracked-pairs', 'john-potfile')).toBeNull()
  })

  it('null hashcatMode returns null (skipped)', () => {
    const row = makeCrackedRow({ hashcatMode: null })
    expect(encodeCrackedRow(row, 'cracked-pairs', 'john-potfile')).toBeNull()
  })
})

// ─── isEmittable predicate ──────────────────────────────────────────────────────

describe('isEmittable', () => {
  it('CSV is always emittable regardless of mode', () => {
    expect(isEmittable(null, 'csv')).toBe(true)
    expect(isEmittable(0, 'csv')).toBe(true)
    expect(isEmittable(500, 'csv')).toBe(true)
  })

  it('hashcat-potfile requires a non-null mode', () => {
    expect(isEmittable(null, 'hashcat-potfile')).toBe(false)
    expect(isEmittable(0, 'hashcat-potfile')).toBe(true)
    expect(isEmittable(500, 'hashcat-potfile')).toBe(true)
  })

  it('john-potfile requires mode in the tag map', () => {
    expect(isEmittable(null, 'john-potfile')).toBe(false)
    expect(isEmittable(0, 'john-potfile')).toBe(true)
    expect(isEmittable(1000, 'john-potfile')).toBe(true)
    expect(isEmittable(500, 'john-potfile')).toBe(false)
    expect(isEmittable(100, 'john-potfile')).toBe(false)
  })
})

// ─── encodeUncrackedRow ──────────────────────────────────────────────────────────

describe('encodeUncrackedRow', () => {
  it('escapes formula trigger in hash value', () => {
    expect(encodeUncrackedRow({ id: 1, hashValue: '=bad' })).toMatch(/^'=bad/)
  })

  it('returns hash value unchanged when no special chars', () => {
    expect(encodeUncrackedRow({ id: 1, hashValue: 'abc123' })).toBe('abc123')
  })
})

// ─── CSV header constants ────────────────────────────────────────────────────────

describe('EXPORT_CSV_HEADERS', () => {
  it('cracked-pairs header contains expected column names', () => {
    const cols = EXPORT_CSV_HEADERS['cracked-pairs'].split(',')
    expect(cols).toContain('hash_value')
    expect(cols).toContain('plaintext')
    expect(cols).toContain('username')
    expect(cols).toContain('source')
    expect(cols).toContain('cracked_at')
  })

  it('plaintext-only header is just plaintext', () => {
    expect(EXPORT_CSV_HEADERS['plaintext-only']).toBe('plaintext')
  })

  it('uncracked header is just hash_value', () => {
    expect(EXPORT_CSV_HEADERS.uncracked).toBe('hash_value')
  })
})
