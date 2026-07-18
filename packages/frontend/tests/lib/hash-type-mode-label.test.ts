import { describe, expect, it } from 'bun:test'

import { hashTypeModeLabel } from '../../src/lib/hash-type-mode-label'

const HASH_TYPES = [
  { hashcatMode: 0, name: 'MD5' },
  { hashcatMode: 1000, name: 'NTLM' },
]

describe('hashTypeModeLabel', () => {
  it('returns the catalog name with the mode number when a match is found', () => {
    expect(hashTypeModeLabel(1000, HASH_TYPES)).toBe('NTLM (mode 1000)')
  })

  it('matches mode 0 (falsy) correctly, not treating it as "no match"', () => {
    expect(hashTypeModeLabel(0, HASH_TYPES)).toBe('MD5 (mode 0)')
  })

  it('falls back to "Mode <n>" when no catalog entry matches', () => {
    expect(hashTypeModeLabel(1800, HASH_TYPES)).toBe('Mode 1800')
  })

  it('falls back to "Mode <n>" when the catalog is empty', () => {
    expect(hashTypeModeLabel(1000, [])).toBe('Mode 1000')
  })
})
