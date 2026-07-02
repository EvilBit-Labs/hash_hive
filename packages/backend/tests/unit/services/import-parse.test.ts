/**
 * Unit tests for the import parse service (issue #102, unit U6).
 *
 * Design: pure string-processing function; no DB connection, no mock.module,
 * no IS_ISOLATED env gate. Runs in the shared `bun test` phase
 * (mirrors tests/unit/services/results-export.test.ts).
 *
 * Scenarios covered:
 *   1. pairs / hash:plain              → { hashValue, plaintext }
 *   2. pairs / user:hash:plain         → { username, hashValue, plaintext }
 *   3. pairs / plaintext with colons   → first-colon rule
 *   4. pairs / empty username          → falls back to 2-token semantics
 *   5. pairs / hash-only line          → skipped (no plaintext to import)
 *   6. pairs / empty plaintext         → skipped
 *   7. hashcat-potfile / unsalted      → fieldCount=1 split
 *   8. hashcat-potfile / salted mode 10 → hashValue='hash:salt' (KTD5 + R6)
 *   9. hashcat-potfile / hashcatMode=null → defaults to fieldCount=1
 *  10. john-potfile / $dynamic_0$ tag → stripped; hashValue matches U3 export
 *  11. john-potfile / $NT$ tag        → stripped; hashValue matches U3 export
 *  12. john-potfile / unrecognized tag → passes through; split at fieldCount=1
 *  13. overlong hashValue (>1024)      → skipped
 *  14. overlong username (>255)        → skipped
 *  15. empty lines                     → ignored, not counted as skipped
 *  16. mixed valid / malformed batch   → correct pair count + skipped total
 */

import { describe, expect, it } from 'bun:test'

import {
  MAX_HASH_VALUE_LENGTH,
  MAX_USERNAME_LENGTH,
  getHashIdentifierFieldCount,
  parseImportContent,
} from '../../../src/services/hash-items/import-parse.js'

// ─── getHashIdentifierFieldCount ─────────────────────────────────────────────

describe('getHashIdentifierFieldCount', () => {
  it('returns 2 for known salted modes', () => {
    expect(getHashIdentifierFieldCount(10)).toBe(2)
    expect(getHashIdentifierFieldCount(20)).toBe(2)
    expect(getHashIdentifierFieldCount(110)).toBe(2)
    expect(getHashIdentifierFieldCount(1410)).toBe(2)
    expect(getHashIdentifierFieldCount(1710)).toBe(2)
  })

  it('returns 1 for unsalted modes', () => {
    expect(getHashIdentifierFieldCount(0)).toBe(1) // MD5
    expect(getHashIdentifierFieldCount(100)).toBe(1) // SHA-1
    expect(getHashIdentifierFieldCount(1000)).toBe(1) // NTLM
    expect(getHashIdentifierFieldCount(1400)).toBe(1) // SHA-256 unsalted
  })

  it('returns 1 when hashcatMode is null', () => {
    expect(getHashIdentifierFieldCount(null)).toBe(1)
  })
})

// ─── pairs format ─────────────────────────────────────────────────────────────

describe('parseImportContent — pairs format', () => {
  it('parses hash:plain as { hashValue, plaintext }', () => {
    const result = parseImportContent('deadbeef:password', 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'password' })
    expect(result.skipped).toBe(0)
  })

  it('parses user:hash:plain as { username, hashValue, plaintext }', () => {
    const result = parseImportContent('alice:deadbeef:password', 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({
      username: 'alice',
      hashValue: 'deadbeef',
      plaintext: 'password',
    })
  })

  it('parses plaintext containing colons via first-colon rule', () => {
    const result = parseImportContent('deadbeef:p:a:s:s', 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'p:a:s:s' })
  })

  it('falls back to 2-token semantics when username is empty (:hash:plain)', () => {
    const result = parseImportContent(':deadbeef:password', 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'password' })
    expect(result.pairs[0]).not.toHaveProperty('username')
  })

  it('skips hash-only lines — no plaintext to import', () => {
    const result = parseImportContent('deadbeef', 'pairs', null)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('skips lines with empty plaintext (2-token form)', () => {
    const result = parseImportContent('deadbeef:', 'pairs', null)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('skips lines with empty plaintext (3-token form user:hash:)', () => {
    const result = parseImportContent('alice:deadbeef:', 'pairs', null)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  // Regression for item A — salted pairs misparse
  it('parses hash:salt:plain as { hashValue:"hash:salt", plaintext } in salted pairs mode', () => {
    // In a salted mode (e.g. 10), a 3-token pairs line is hash:salt:plaintext, not user:hash:plain.
    // The stored identifier for mode 10 is 'hash:salt' so the import must reconstruct it.
    const result = parseImportContent('abc123:mysalt:password', 'pairs', 10)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'abc123:mysalt', plaintext: 'password' })
    expect(result.skipped).toBe(0)
  })

  it('still parses user:hash:plain under unsalted mode (item A regression guard)', () => {
    // hashcatMode=0 is unsalted; 3-token form is user:hash:plain
    const result = parseImportContent('alice:deadbeef:password', 'pairs', 0)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({
      username: 'alice',
      hashValue: 'deadbeef',
      plaintext: 'password',
    })
  })
})

// ─── hashcat-potfile format ───────────────────────────────────────────────────

describe('parseImportContent — hashcat-potfile format', () => {
  it('parses unsalted mode (fieldCount=1) correctly', () => {
    const result = parseImportContent('deadbeef:password', 'hashcat-potfile', 0)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'password' })
  })

  it('parses salted mode 10 (fieldCount=2) — KTD5 + R6 round-trip', () => {
    // Stored hashValue for mode 10 is `hash:salt`; potfile line is `hash:salt:plain`
    const result = parseImportContent('abc123:mysalt:password', 'hashcat-potfile', 10)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'abc123:mysalt', plaintext: 'password' })
  })

  it('defaults to fieldCount=1 when hashcatMode is null', () => {
    const result = parseImportContent('deadbeef:password', 'hashcat-potfile', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'password' })
  })

  it('skips malformed lines missing any separator', () => {
    const result = parseImportContent('malformedline', 'hashcat-potfile', 0)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('skips lines with empty plaintext', () => {
    const result = parseImportContent('deadbeef:', 'hashcat-potfile', 0)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('skips salted-mode lines missing the second separator', () => {
    // Mode 10 expects `hash:salt:plain`; only one colon present → skip
    const result = parseImportContent('abc123:onlyonesep', 'hashcat-potfile', 10)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })
})

// ─── john-potfile format ──────────────────────────────────────────────────────

describe('parseImportContent — john-potfile format', () => {
  it('strips $dynamic_0$ tag and parses MD5 line — R6 round-trip', () => {
    // U3 export: encodeCrackedRow({ hashValue: 'deadbeef', ... }, 'cracked-pairs', 'john-potfile')
    // → '$dynamic_0$deadbeef:password'
    const result = parseImportContent('$dynamic_0$deadbeef:password', 'john-potfile', 0)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'password' })
  })

  it('strips $NT$ tag and parses NTLM line — R6 round-trip', () => {
    const result = parseImportContent('$NT$ntlmhash:password', 'john-potfile', 1000)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'ntlmhash', plaintext: 'password' })
  })

  it('does not strip unrecognized $...$-style tags (e.g. crypt $1$)', () => {
    // $1$salt$hash is not in JOHN_FORMAT_TAGS; passes through unmodified.
    // Split at first colon → hashValue='$1$salt$hash', plaintext='password'
    const result = parseImportContent('$1$salt$hash:password', 'john-potfile', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: '$1$salt$hash', plaintext: 'password' })
  })

  it('skips malformed john line after tag stripping (no colon remains)', () => {
    const result = parseImportContent('$dynamic_0$deadbeefNOCOLON', 'john-potfile', 0)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('skips john line with empty plaintext after tag strip', () => {
    const result = parseImportContent('$NT$ntlmhash:', 'john-potfile', 1000)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })
})

// ─── length caps and edge cases ───────────────────────────────────────────────

describe('parseImportContent — length caps and edge cases', () => {
  it('skips lines whose hashValue exceeds MAX_HASH_VALUE_LENGTH', () => {
    const longHash = 'a'.repeat(MAX_HASH_VALUE_LENGTH + 1)
    const result = parseImportContent(`${longHash}:password`, 'pairs', null)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('accepts lines whose hashValue is exactly MAX_HASH_VALUE_LENGTH', () => {
    const hash = 'a'.repeat(MAX_HASH_VALUE_LENGTH)
    const result = parseImportContent(`${hash}:password`, 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.hashValue).toHaveLength(MAX_HASH_VALUE_LENGTH)
  })

  it('skips lines whose username exceeds MAX_USERNAME_LENGTH', () => {
    const longUser = 'u'.repeat(MAX_USERNAME_LENGTH + 1)
    const result = parseImportContent(`${longUser}:deadbeef:password`, 'pairs', null)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('accepts lines whose username is exactly MAX_USERNAME_LENGTH', () => {
    const user = 'u'.repeat(MAX_USERNAME_LENGTH)
    const result = parseImportContent(`${user}:deadbeef:password`, 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.username).toHaveLength(MAX_USERNAME_LENGTH)
  })

  it('ignores empty lines without counting them as skipped', () => {
    const content = 'deadbeef:password\n\n  \nanotherhash:secret'
    const result = parseImportContent(content, 'pairs', null)

    expect(result.pairs).toHaveLength(2)
    expect(result.skipped).toBe(0)
  })

  it('handles a mixed batch of valid and malformed lines', () => {
    const content = [
      'deadbeef:password', // valid
      'malformed', // skip: no plaintext
      'alice:abc123:secret', // valid
      '', // ignored (empty)
      'tooshort:', // skip: empty plaintext
    ].join('\n')

    const result = parseImportContent(content, 'pairs', null)

    expect(result.pairs).toHaveLength(2)
    expect(result.skipped).toBe(2)
  })

  it('returns empty pairs and zero skipped for empty input', () => {
    const result = parseImportContent('', 'pairs', null)

    expect(result.pairs).toHaveLength(0)
    expect(result.skipped).toBe(0)
  })

  it('preserves trailing whitespace in plaintext (byte-exact round-trip safety)', () => {
    // A password that ends in a space must survive import intact.
    // Trimming the line before parsing would corrupt it to 'pass'.
    const result = parseImportContent('deadbeef:pass ', 'pairs', null)

    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'pass ' })
  })

  it('handles CRLF line endings without including \\r in parsed values', () => {
    const content = 'deadbeef:password\r\nalice:abc123:secret\r\n'
    const result = parseImportContent(content, 'pairs', null)

    expect(result.pairs).toHaveLength(2)
    expect(result.pairs[0]).toEqual({ hashValue: 'deadbeef', plaintext: 'password' })
    expect(result.pairs[1]).toEqual({ username: 'alice', hashValue: 'abc123', plaintext: 'secret' })
    expect(result.skipped).toBe(0)
  })
})
