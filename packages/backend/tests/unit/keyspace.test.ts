/**
 * Unit tests for `calculateAttackKeyspace`.
 *
 * The function maps an attack's hashcat mode + wordlist/rule/mask metadata
 * onto a total keyspace value, returned as a bigint-decimal string because
 * mask-attack keyspaces routinely exceed `Number.MAX_SAFE_INTEGER`. Anything
 * the function can't reason about (unknown mode, missing required input,
 * unknown mask token) must return `null` so the caller falls back to the
 * existing single-task path rather than guessing wrong.
 */
import { describe, expect, test } from 'bun:test'

import {
  calculateAttackKeyspace,
  sumMasklistKeyspace,
  sumMasklistKeyspaceFromStream,
} from '../../src/services/keyspace.js'

// Match the resource line-length cap used by the streaming callers so the
// over-length boundary scenario mirrors production.
const MAX_LINE_LENGTH = 10_000

describe('calculateAttackKeyspace - mode 0 (straight)', () => {
  test('returns wordlist * rules', () => {
    expect(calculateAttackKeyspace({ mode: 0, wordlistRows: 1000, rulelistRows: 10 })).toBe('10000')
  })

  test('treats missing rulelist as 1', () => {
    expect(calculateAttackKeyspace({ mode: 0, wordlistRows: 1000 })).toBe('1000')
  })

  test('treats empty rulelist as 1', () => {
    expect(calculateAttackKeyspace({ mode: 0, wordlistRows: 1000, rulelistRows: 0 })).toBe('1000')
  })

  test('returns null when wordlist is missing', () => {
    expect(calculateAttackKeyspace({ mode: 0 })).toBe(null)
  })
})

describe('calculateAttackKeyspace - mode 1 (combination)', () => {
  test('returns wordlistA * wordlistB', () => {
    expect(
      calculateAttackKeyspace({ mode: 1, wordlistRows: 1000, secondaryWordlistRows: 2000 })
    ).toBe('2000000')
  })

  test('returns null when only one wordlist is supplied', () => {
    expect(calculateAttackKeyspace({ mode: 1, wordlistRows: 1000 })).toBe(null)
    expect(calculateAttackKeyspace({ mode: 1, secondaryWordlistRows: 1000 })).toBe(null)
  })
})

describe('calculateAttackKeyspace - mode 3 (mask)', () => {
  test('all-digit 4-char mask returns 10^4', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?d?d?d?d' })).toBe('10000')
  })

  test('all-lower 4-char mask returns 26^4', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?l?l?l?l' })).toBe('456976')
  })

  test('single ?a token expands to printable ASCII (95 chars)', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?a' })).toBe('95')
  })

  test('literal prefix contributes 1 per position', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: 'password?d' })).toBe('10')
  })

  test('unknown ?-token returns null (refuses to guess)', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?z' })).toBe(null)
  })

  test('?? is a literal question mark (hashcat escape), contributes 1', () => {
    // `??` -> single literal `?`. `?d` -> 10 candidates. Total: 1 * 10 = 10.
    expect(calculateAttackKeyspace({ mode: 3, mask: '???d' })).toBe('10')
  })

  test('?? at end of mask is accepted as a literal', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: 'pw??' })).toBe('1')
  })

  test('returns null when mask is missing', () => {
    expect(calculateAttackKeyspace({ mode: 3 })).toBe(null)
  })

  test('returns null on empty mask', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '' })).toBe(null)
  })

  test('long mask exceeds Number.MAX_SAFE_INTEGER and returns precise decimal string', () => {
    // ?a^12 = 95^12 ~ 5.4e23, well above 2^53 ~ 9e15
    const value = calculateAttackKeyspace({ mode: 3, mask: '?a?a?a?a?a?a?a?a?a?a?a?a' })
    expect(typeof value).toBe('string')
    expect(value).toBe('540360087662636962890625')
  })
})

describe('calculateAttackKeyspace - modes 6 / 7 (hybrid)', () => {
  test('mode 6 (wordlist + mask)', () => {
    expect(calculateAttackKeyspace({ mode: 6, wordlistRows: 1000, mask: '?d?d' })).toBe('100000')
  })

  test('mode 7 (mask + wordlist)', () => {
    expect(calculateAttackKeyspace({ mode: 7, mask: '?d?d', wordlistRows: 1000 })).toBe('100000')
  })

  test('mode 6 returns null without wordlist', () => {
    expect(calculateAttackKeyspace({ mode: 6, mask: '?d?d' })).toBe(null)
  })

  test('mode 6 returns null without mask', () => {
    expect(calculateAttackKeyspace({ mode: 6, wordlistRows: 1000 })).toBe(null)
  })
})

describe('calculateAttackKeyspace - unsupported modes', () => {
  test('mode 99 returns null', () => {
    expect(calculateAttackKeyspace({ mode: 99, wordlistRows: 1000 })).toBe(null)
  })

  test('mode 9 returns null even with full inputs', () => {
    expect(calculateAttackKeyspace({ mode: 9, wordlistRows: 1000, mask: '?d?d' })).toBe(null)
  })
})

describe('calculateAttackKeyspace - mode 3 via stored masklist keyspace', () => {
  test('uses masklistKeyspace when no inline mask is present', () => {
    expect(calculateAttackKeyspace({ mode: 3, masklistKeyspace: '1676' })).toBe('1676')
  })

  test('inline mask wins over masklistKeyspace (precedence)', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?d?d', masklistKeyspace: '999999' })).toBe(
      '100'
    )
  })

  test('returns null when masklist keyspace is absent and no mask', () => {
    expect(calculateAttackKeyspace({ mode: 3 })).toBe(null)
  })

  test('modes 6/7 ignore masklistKeyspace (single-mask only)', () => {
    expect(calculateAttackKeyspace({ mode: 6, wordlistRows: 1000, masklistKeyspace: '50' })).toBe(
      null
    )
    expect(calculateAttackKeyspace({ mode: 7, wordlistRows: 1000, masklistKeyspace: '50' })).toBe(
      null
    )
  })

  test('mode 0 ignores masklistKeyspace (a masklist-backed straight attack is not chunked by it)', () => {
    // masklistKeyspace is a mode-3 concept; a mode-0 attack is sized by its
    // wordlist, never by a stray masklist sum, so this must not return 50.
    expect(calculateAttackKeyspace({ mode: 0, masklistKeyspace: '50' })).toBe(null)
  })
})

describe('sumMasklistKeyspace - .hcmask line classification + summation', () => {
  const sum = (lines: string[]) => sumMasklistKeyspace(lines, MAX_LINE_LENGTH)

  test('single mask line returns its keyspace', () => {
    expect(sum(['?d?d?d?d'])).toBe('10000')
  })

  test('sums multiple mask lines', () => {
    // ?l?l = 676, ?d?d?d = 1000 -> 1676
    expect(sum(['?l?l', '?d?d?d'])).toBe('1676')
  })

  test('sum exceeds Number.MAX_SAFE_INTEGER and stays a precise decimal string', () => {
    // two ?a^12 lines: 2 * 540360087662636962890625
    const value = sum(['?a?a?a?a?a?a?a?a?a?a?a?a', '?a?a?a?a?a?a?a?a?a?a?a?a'])
    expect(typeof value).toBe('string')
    expect(value).toBe('1080720175325273925781250')
  })

  test('blank lines are skipped (contribute nothing, do not null)', () => {
    expect(sum(['?d?d', '', '   ', '?d?d'])).toBe('200')
  })

  test('# comment lines are skipped', () => {
    expect(sum(['# header comment', '?d?d'])).toBe('100')
  })

  test('escaped \\# leading line is a real mask line, not a comment', () => {
    // `\#?d` -> literal `\`, literal `#`, then ?d(10) = 10
    expect(sum(['\\#?d'])).toBe('10')
  })

  test('unescaped-comma (custom-charset definition) line nulls the whole list', () => {
    // `?d?l,abc` defines custom charset ?1=?d?l (unused); true keyspace is 1,
    // NOT 260. We cannot compute custom charsets -> whole masklist null.
    expect(sum(['?d?l,abc'])).toBe(null)
  })

  test('escaped \\, literal comma is computable (not a charset separator)', () => {
    // `a\,?d` -> literals a, \, , then ?d(10) = 10
    expect(sum(['a\\,?d'])).toBe('10')
  })

  test('escaped backslash before a comma (\\\\,) leaves the comma a real separator -> null', () => {
    // `\\,abc` -> escaped literal backslash, then an UNESCAPED comma = custom
    // charset definition. Backslash-run parity: 2 backslashes (even) before the
    // comma means it is not escaped. A single-preceding-char check would miss this.
    expect(sum(['\\\\,abc'])).toBe(null)
  })

  test('escaped backslash then escaped comma (\\\\\\,) is computable', () => {
    // `\\\,?d` -> escaped literal backslash, escaped literal comma, then ?d(10).
    // 3 backslashes (odd) before the comma means the comma IS escaped = literal.
    expect(sum(['\\\\\\,?d'])).toBe('10')
  })

  test('line referencing a custom charset ?1 nulls the whole list', () => {
    expect(sum(['?1?1'])).toBe(null)
  })

  test('unknown ?-token nulls the whole list', () => {
    expect(sum(['?z'])).toBe(null)
  })

  test('over-length line nulls the whole list (not silently skipped)', () => {
    const longMask = '?d'.repeat(MAX_LINE_LENGTH) // far over the cap
    expect(sum([longMask])).toBe(null)
  })

  test('empty / all-comment file returns null (nothing to compute)', () => {
    expect(sum([])).toBe(null)
    expect(sum(['', '# only comments', '   '])).toBe(null)
  })

  test('one bad line among good ones nulls the whole list (never skip-and-sum)', () => {
    expect(sum(['?d?d', '?1', '?d?d'])).toBe(null)
  })
})

describe('sumMasklistKeyspaceFromStream - streaming twin matches the sync sum', () => {
  async function* stream(lines: string[]): AsyncGenerator<string> {
    for (const line of lines) yield line
  }
  const sumStream = (lines: string[]) =>
    sumMasklistKeyspaceFromStream(stream(lines), MAX_LINE_LENGTH)

  test('sums multiple mask lines from a stream', async () => {
    expect(await sumStream(['?l?l', '?d?d?d'])).toBe('1676')
  })

  test('stops and nulls the whole list on the first uncomputable line', async () => {
    expect(await sumStream(['?d?d', '?1', '?d?d'])).toBe(null)
  })

  test('empty stream returns null (nothing to compute)', async () => {
    expect(await sumStream([])).toBe(null)
  })
})
