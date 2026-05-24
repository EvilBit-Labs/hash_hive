import { describe, expect, it } from 'bun:test'

import { ATTACK_MODES, attackModeLabel } from '../../src/lib/attack-modes'

describe('ATTACK_MODES', () => {
  it('exposes all five spec-listed primitives with correct hashcat -a values', () => {
    const values = ATTACK_MODES.map((mode) => mode.value)
    expect(values).toEqual([0, 1, 3, 6, 7])
  })

  it('labels every option with a non-empty human-readable name', () => {
    for (const mode of ATTACK_MODES) {
      expect(mode.label.length).toBeGreaterThan(0)
    }
  })
})

describe('attackModeLabel', () => {
  it('returns the Dictionary label for hashcat mode 0', () => {
    expect(attackModeLabel(0)).toBe('Dictionary')
  })

  it('returns the Combinator label for hashcat mode 1', () => {
    expect(attackModeLabel(1)).toBe('Combinator')
  })

  it('returns the Mask label for hashcat mode 3 (mask wins the shared-value collision with brute-force)', () => {
    expect(attackModeLabel(3)).toBe('Mask')
  })

  it('returns the Hybrid wordlist+mask label for hashcat mode 6', () => {
    expect(attackModeLabel(6)).toBe('Hybrid (wordlist + mask)')
  })

  it('returns the Hybrid mask+wordlist label for hashcat mode 7', () => {
    expect(attackModeLabel(7)).toBe('Hybrid (mask + wordlist)')
  })

  it('returns a generic "Mode <n>" string for unknown numeric values', () => {
    expect(attackModeLabel(99)).toBe('Mode 99')
    expect(attackModeLabel(2)).toBe('Mode 2')
  })
})
