/**
 * Import parse service for pre-cracked material (issue #102, unit U6).
 *
 * Parses raw content in pairs, hashcat-potfile, or john-potfile format
 * into normalized { username?, hashValue, plaintext } pairs.
 *
 * Design notes:
 *   - NO module-scope DB import. Pure string processing; loads in test
 *     phases without a live DB connection (mirrors results/export.ts).
 *   - Format is an EXPLICIT discriminator — never inferred from token count.
 *   - Malformed lines and overlong values are COUNTED (skipped), never thrown.
 *   - Lines with no plaintext are SKIPPED — this is import of cracked
 *     material, not ingestion of an uncracked hash list.
 *   - Potfile parsing is MODE-AWARE (KTD5): the hash-identifier field count
 *     derives from the target list's hashcatMode via getHashIdentifierFieldCount.
 */

import type { ImportFormat } from '@hashhive/shared'

import { JOHN_FORMAT_TAGS } from '../results/export.js'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max varchar length for the hashValue column (U1 schema). */
export const MAX_HASH_VALUE_LENGTH = 1024

/** Max varchar length for the username column (U1 schema). */
export const MAX_USERNAME_LENGTH = 255

// ─── Salted-mode field count ─────────────────────────────────────────────────

/**
 * Conservative set of hashcat modes where the hash identifier spans two
 * colon-separated fields, stored as `hash:salt`.
 *
 * The export service (results/export.ts) sidesteps field-counting because the
 * stored hashValue already contains the right form (`hash:salt`). Import must
 * reconstruct the field boundary from the mode — this set is the single
 * source of truth for that logic.
 *
 * Omitted intentionally:
 *   - Modes whose hashValue is self-identifying (e.g., `$1$`, `$6$`, `$2y$`)
 *     — the embedded `$` characters would cause a wrong colon split.
 *   - Any 3+ field modes — none encountered; expand when confirmed.
 *
 * Expand when a new salted mode is confirmed from hashcat example hashes.
 */
export const SALTED_HASHCAT_MODES: ReadonlySet<number> = new Set([
  // MD5 variants with separate salt field
  10, 20, 30, 40, 50, 60,
  // SHA-1 variants
  110, 120, 130, 140, 150, 160,
  // SHA-256 variants
  1410, 1420, 1430, 1440, 1450, 1460,
  // SHA-512 variants
  1710, 1720, 1730, 1740, 1750, 1760,
])

/**
 * Returns the number of colon-separated tokens the hash identifier occupies
 * in a potfile line for the given hashcat mode.
 *
 *   - 2 → salted mode (hashValue stored as `hash:salt`)
 *   - 1 → unsalted or unknown (hashValue stored as plain `hash`)
 *
 * When `hashcatMode` is `null` (target list has no hash type set), defaults
 * to 1. The resulting hashValue may not match any stored row, but the parser
 * must not throw; the mismatch surfaces at upsert time (U8).
 */
export function getHashIdentifierFieldCount(hashcatMode: number | null): 1 | 2 {
  if (hashcatMode === null) return 1
  return SALTED_HASHCAT_MODES.has(hashcatMode) ? 2 : 1
}

// ─── John tag inversion ──────────────────────────────────────────────────────

/**
 * Inverted JOHN_FORMAT_TAGS: tag string → hashcat mode number.
 *
 * Only tags from JOHN_FORMAT_TAGS are recognized during import. Generic
 * `$x$` patterns (crypt hashes starting with `$1$`, `$6$`, `$2y$`, etc.)
 * are intentionally NOT stripped to avoid mis-parsing them as tagged lines.
 */
const JOHN_TAG_TO_MODE: ReadonlyMap<string, number> = new Map(
  Object.entries(JOHN_FORMAT_TAGS).map(([mode, tag]) => [tag as string, Number(mode)])
)

// ─── Types ────────────────────────────────────────────────────────────────────

/** A normalized pair parsed from a pre-cracked line. */
export type ParsedImportPair = {
  readonly username?: string
  readonly hashValue: string
  readonly plaintext: string
}

/** Result of parsing a batch of pre-cracked lines. */
export type ImportParseResult = {
  readonly pairs: readonly ParsedImportPair[]
  readonly skipped: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate length caps and return a pair or null (skip).
 * Extracted to avoid repeating the constraint logic in every parse branch.
 */
function makePair(
  hashValue: string,
  plaintext: string,
  username?: string
): ParsedImportPair | null {
  if (!hashValue) return null
  if (hashValue.length > MAX_HASH_VALUE_LENGTH) return null
  if (username !== undefined && username.length > MAX_USERNAME_LENGTH) return null
  if (username !== undefined && username.length > 0) {
    return { username, hashValue, plaintext }
  }
  return { hashValue, plaintext }
}

// ─── Pairs parser ─────────────────────────────────────────────────────────────

/**
 * Parse a single line in `pairs` format.
 *
 * Mirrors parseHashLine semantics (queue/workers/hash-list-parser.ts) but:
 *   a) returns `{ username?, hashValue, plaintext }` instead of a DB-insert shape.
 *   b) SKIPS lines with no plaintext — importing cracked material only.
 *
 * Token rules:
 *   1 token  → hash only              → SKIP (no plaintext)
 *   2 tokens → `hash:plain`           → `{ hashValue, plaintext }`
 *   3 tokens → `user:hash:plain`      → `{ username, hashValue, plaintext }`
 *              `:hash:plain`           → empty username → 2-token semantics
 *              `user:hash:`            → empty plaintext → SKIP
 *   4+ tokens → first-colon-as-separator (plaintext may contain colons)
 */
function parsePairsLine(line: string): ParsedImportPair | null {
  const firstColon = line.indexOf(':')
  if (firstColon === -1) return null // 1 token: no plaintext

  const tokens = line.split(':')

  if (tokens.length === 2) {
    const [hashValue, plaintext] = tokens as [string, string]
    if (!plaintext) return null
    return makePair(hashValue, plaintext)
  }

  if (tokens.length === 3) {
    const [username, hashValue, plaintext] = tokens as [string, string, string]
    if (!hashValue) return null
    if (!plaintext) return null
    if (!username) return makePair(hashValue, plaintext) // `:hash:plain` fallback
    return makePair(hashValue, plaintext, username)
  }

  // 4+ tokens: first-colon-as-separator; plaintext may contain colons
  const hashValue = line.substring(0, firstColon)
  const plaintext = line.substring(firstColon + 1)
  if (!plaintext) return null
  return makePair(hashValue, plaintext)
}

// ─── Potfile split ────────────────────────────────────────────────────────────

/**
 * Split a potfile line into hashValue and plaintext using the field count.
 *
 *   fieldCount=1: `hash:plaintext`       → first colon is the separator
 *   fieldCount=2: `hash:salt:plaintext`  → second colon is the separator
 *
 * Missing or empty plaintext is a skip (consistent with pairs mode).
 */
function splitPotfileLine(line: string, fieldCount: 1 | 2): ParsedImportPair | null {
  const firstColon = line.indexOf(':')
  if (firstColon === -1) return null

  if (fieldCount === 1) {
    const hashValue = line.substring(0, firstColon)
    const plaintext = line.substring(firstColon + 1)
    if (!plaintext) return null
    return makePair(hashValue, plaintext)
  }

  // fieldCount === 2: second colon separates `hash:salt` from `plaintext`
  const secondColon = line.indexOf(':', firstColon + 1)
  if (secondColon === -1) return null // no second separator → missing plaintext
  const hashValue = line.substring(0, secondColon)
  const plaintext = line.substring(secondColon + 1)
  if (!plaintext) return null
  return makePair(hashValue, plaintext)
}

// ─── Format-specific parsers ──────────────────────────────────────────────────

function parseHashcatPotfileLine(
  line: string,
  hashcatMode: number | null
): ParsedImportPair | null {
  return splitPotfileLine(line, getHashIdentifierFieldCount(hashcatMode))
}

/**
 * Parse a single john-potfile line.
 *
 * Strips the recognized `$tag$` prefix (from JOHN_TAG_TO_MODE), resolves the
 * hashcat mode from the tag, then applies mode-aware potfile splitting.
 *
 * Lines with an unrecognized `$...$` pattern are NOT stripped — they pass
 * through and are split at fieldCount=1 using the caller's hashcatMode. A
 * `$1$`-style crypt hash will not match any stored hashValue, but the mismatch
 * surfaces at upsert time (U8), not as a thrown exception here.
 */
function parseJohnPotfileLine(line: string, hashcatMode: number | null): ParsedImportPair | null {
  let remaining = line
  let resolvedMode = hashcatMode

  for (const [tag, mode] of JOHN_TAG_TO_MODE) {
    if (line.startsWith(tag)) {
      remaining = line.slice(tag.length)
      resolvedMode = mode
      break
    }
  }

  return splitPotfileLine(remaining, getHashIdentifierFieldCount(resolvedMode))
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse pre-cracked material into normalized pairs.
 *
 * @param content     Raw file content; split on LF or CRLF line endings.
 * @param format      Explicit format discriminator — never inferred.
 * @param hashcatMode The target list's hashcat mode, used by potfile formats
 *                    to determine the hash-identifier field count (KTD5).
 *                    Pass `null` when the list has no hash type set; potfile
 *                    lines default to single-field parsing (field count 1).
 * @returns Normalized pairs and the count of skipped (malformed/overlong) lines.
 */
export function parseImportContent(
  content: string,
  format: ImportFormat,
  hashcatMode: number | null
): ImportParseResult {
  const pairs: ParsedImportPair[] = []
  let skipped = 0

  for (const raw of content.split(/\r?\n/)) {
    // Trim only to detect blank/whitespace-only lines; parse `raw` unmodified
    // so that plaintexts with leading/trailing whitespace survive intact.
    if (raw.trim().length === 0) continue

    let pair: ParsedImportPair | null
    if (format === 'pairs') {
      pair = parsePairsLine(raw)
    } else if (format === 'hashcat-potfile') {
      pair = parseHashcatPotfileLine(raw, hashcatMode)
    } else {
      pair = parseJohnPotfileLine(raw, hashcatMode)
    }

    if (pair === null) {
      skipped++
    } else {
      pairs.push(pair)
    }
  }

  return { pairs, skipped }
}
