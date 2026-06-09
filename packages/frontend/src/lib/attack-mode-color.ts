import type { AttackModeName } from '@hashhive/shared'

/**
 * Editorial color encoding for hashcat attack modes.
 *
 * Each mode gets a stable Catppuccin accent so the Results table's
 * Attack column communicates the attack family at a glance instead
 * of reading as a uniform field of muted text. Honors the
 * .impeccable.md "per-attack-mode colors for chunking" direction.
 * The mapping is a stable per-mode assignment, not a fixed
 * sequence — Mask gets lavender and Association gets mauve to
 * keep semantically distinct attacks visually distinct, even
 * though those colors fall outside the editorial graph-series
 * sequence the doc names for charts.
 *
 * Color is paired with a leading bullet glyph at the call site
 * (results-table.tsx) so the encoding survives color-blind operators
 * and grayscale screenshots — color + non-color cue + label.
 */
const MODE_COLOR: Readonly<Record<AttackModeName, string>> = {
  Dictionary: 'text-ctp-sky',
  Combination: 'text-ctp-sapphire',
  Mask: 'text-ctp-lavender',
  'Hybrid Wordlist + Mask': 'text-ctp-teal',
  'Hybrid Mask + Wordlist': 'text-ctp-green',
  Association: 'text-ctp-mauve',
}

/**
 * Resolve a hashcat attack mode name to its Tailwind text-color class.
 * Unknown / unresolved modes (`null`) fall back to the muted treatment
 * the rest of the row uses.
 */
export function attackModeColorClass(mode: AttackModeName | null): string {
  if (mode === null) return 'text-muted-foreground'
  return MODE_COLOR[mode]
}
