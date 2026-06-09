import { describe, expect, it } from 'bun:test'

import { attackModeColorClass } from '../../src/lib/attack-mode-color'

describe('attackModeColorClass', () => {
  it('maps every supported hashcat attack mode to a stable Catppuccin class', () => {
    expect(attackModeColorClass('Dictionary')).toBe('text-ctp-sky')
    expect(attackModeColorClass('Combination')).toBe('text-ctp-sapphire')
    expect(attackModeColorClass('Mask')).toBe('text-ctp-lavender')
    expect(attackModeColorClass('Hybrid Wordlist + Mask')).toBe('text-ctp-teal')
    expect(attackModeColorClass('Hybrid Mask + Wordlist')).toBe('text-ctp-green')
    expect(attackModeColorClass('Association')).toBe('text-ctp-mauve')
  })

  it('falls back to the muted treatment for null (unresolved attack mode)', () => {
    expect(attackModeColorClass(null)).toBe('text-muted-foreground')
  })
})
