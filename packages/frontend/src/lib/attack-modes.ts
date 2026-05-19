/**
 * Hashcat attack-type values for the `-a` flag.
 *
 * Note: hashcat mode `3` is shared between mask and brute-force attacks
 * (brute-force is implemented as a mask attack with `?a?a?a?a?a?a?a?a`).
 * The wizard surfaces this single value as "Mask" because that is the
 * primitive the configuration form models; pure brute-force is a special
 * case of mask with a generated charset.
 */
export const ATTACK_MODES = [
  { value: 0, label: 'Dictionary' },
  { value: 1, label: 'Combinator' },
  { value: 3, label: 'Mask' },
  { value: 6, label: 'Hybrid (wordlist + mask)' },
  { value: 7, label: 'Hybrid (mask + wordlist)' },
] as const;

export type AttackModeValue = (typeof ATTACK_MODES)[number]['value'];

/**
 * Returns the human-readable label for a hashcat attack mode value, or
 * `Mode <n>` when the value is not one of the spec-listed primitives.
 * Unknown numeric values are tolerated so power users can craft modes
 * the dropdown does not enumerate without breaking the UI.
 */
export function attackModeLabel(value: number): string {
  const match = ATTACK_MODES.find((mode) => mode.value === value);
  return match ? match.label : `Mode ${value}`;
}
