/**
 * Attack-keyspace calculator.
 *
 * Maps a hashcat attack's mode + dictionaries + mask onto the total keyspace
 * the attack covers. Returned as a bigint-decimal string because mask-attack
 * keyspaces routinely exceed `Number.MAX_SAFE_INTEGER` (e.g. ?a^12 ~ 5.4e23).
 *
 * Callers persist the result into `attacks.keyspace varchar(255)` and use it
 * to chunk the work for distribution. When this function returns `null`, the
 * caller falls back to the existing single-task path rather than guessing -
 * we'd rather under-chunk than mis-chunk.
 *
 * This module is pure: no DB access, no I/O. Test in isolation in
 * `tests/unit/keyspace.test.ts`.
 */

export interface CalculateAttackKeyspaceInput {
  /** Hashcat attack mode (-a flag). */
  mode: number;
  /** Row count of the primary wordlist (modes 0, 1, 6, 7). */
  wordlistRows?: number;
  /** Row count of the rule list (multiplier on mode 0). */
  rulelistRows?: number;
  /** Row count of the second wordlist (mode 1 combination only). */
  secondaryWordlistRows?: number;
  /** Mask string (modes 3, 6, 7). */
  mask?: string;
}

// Hashcat mask charset sizes for the standard ?-tokens. Keep this map narrow
// - any token outside this set causes the calculator to return null rather
// than guess. Reference: https://hashcat.net/wiki/doku.php?id=mask_attack
const MASK_CHARSETS: Record<string, number> = {
  l: 26, // lowercase a-z
  u: 26, // uppercase A-Z
  d: 10, // digits 0-9
  s: 33, // special characters (printable, non-alnum)
  a: 95, // all printable ASCII (?l + ?u + ?d + ?s)
  h: 16, // hex lowercase 0-9a-f
  H: 16, // hex uppercase 0-9A-F
  b: 256, // all bytes (0x00-0xff)
};

/**
 * Parse a mask string into the product of its per-position charset sizes.
 * Returns `null` for missing/empty masks and for masks containing unknown
 * `?` tokens - caller must decide whether to fall back or fail loudly.
 */
function calculateMaskKeyspace(mask: string): bigint | null {
  if (mask.length === 0) return null;
  let product = 1n;
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === '?') {
      const token = mask[i + 1];
      if (token === undefined) return null;
      const size = MASK_CHARSETS[token];
      if (size === undefined) return null;
      product *= BigInt(size);
      i += 1; // skip the token char
    } else {
      // Literal character contributes 1 (fixed in that position).
      product *= 1n;
    }
  }
  return product;
}

export function calculateAttackKeyspace(input: CalculateAttackKeyspaceInput): string | null {
  switch (input.mode) {
    case 0: {
      // Straight: wordlist * max(rules, 1)
      if (input.wordlistRows === undefined || input.wordlistRows <= 0) return null;
      const rules = input.rulelistRows && input.rulelistRows > 0 ? input.rulelistRows : 1;
      return (BigInt(input.wordlistRows) * BigInt(rules)).toString();
    }
    case 1: {
      // Combination: wordlistA * wordlistB
      if (
        input.wordlistRows === undefined ||
        input.wordlistRows <= 0 ||
        input.secondaryWordlistRows === undefined ||
        input.secondaryWordlistRows <= 0
      ) {
        return null;
      }
      return (BigInt(input.wordlistRows) * BigInt(input.secondaryWordlistRows)).toString();
    }
    case 3: {
      // Mask: product of per-position charset sizes
      if (!input.mask) return null;
      const maskKs = calculateMaskKeyspace(input.mask);
      return maskKs === null ? null : maskKs.toString();
    }
    case 6: {
      // Hybrid wordlist + mask: wordlist * mask
      if (input.wordlistRows === undefined || input.wordlistRows <= 0 || !input.mask) return null;
      const maskKs = calculateMaskKeyspace(input.mask);
      if (maskKs === null) return null;
      return (BigInt(input.wordlistRows) * maskKs).toString();
    }
    case 7: {
      // Hybrid mask + wordlist: mask * wordlist
      if (input.wordlistRows === undefined || input.wordlistRows <= 0 || !input.mask) return null;
      const maskKs = calculateMaskKeyspace(input.mask);
      if (maskKs === null) return null;
      return (maskKs * BigInt(input.wordlistRows)).toString();
    }
    default:
      // Unknown / unsupported mode - caller falls back to single-task path.
      return null;
  }
}
