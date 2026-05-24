import { hashTypes } from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'

// ─── Hash Type Detection Patterns ───────────────────────────────────
//
// Each pattern describes a hash format by its regex, expected length,
// associated hashcat mode, and a human-readable name. Patterns are
// ordered by real-world popularity so the most likely candidates
// appear first (mirrors name-that-hash's popularity ranking).

interface HashPattern {
  name: string
  hashcatMode: number
  regex: RegExp
  category: string
}

const HASH_PATTERNS: HashPattern[] = [
  // ─── Structured / prefixed formats (check first) ──────────────
  {
    name: 'bcrypt',
    hashcatMode: 3200,
    regex: /^\$2[aby]?\$\d{2}\$.{53}$/,
    category: 'Password Hashing',
  },
  {
    name: 'MD5 Crypt',
    hashcatMode: 500,
    regex: /^\$1\$.{8}\$.{22}$/,
    category: 'Password Hashing',
  },
  {
    name: 'SHA-256 Crypt',
    hashcatMode: 7400,
    regex: /^\$5\$(rounds=\d+\$)?[^$]+\$[a-zA-Z0-9/.]{43}$/,
    category: 'Password Hashing',
  },
  {
    name: 'SHA-512 Crypt',
    hashcatMode: 1800,
    regex: /^\$6\$(rounds=\d+\$)?[^$]+\$[a-zA-Z0-9/.]{86}$/,
    category: 'Password Hashing',
  },
  {
    name: 'PHPass',
    hashcatMode: 400,
    regex: /^\$P\$[a-zA-Z0-9/.]{31}$/,
    category: 'Password Hashing',
  },
  {
    name: 'scrypt',
    hashcatMode: 8900,
    regex: /^SCRYPT:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    category: 'Password Hashing',
  },
  {
    name: 'Argon2',
    hashcatMode: 13600,
    regex: /^\$argon2(i|d|id)\$/,
    category: 'Password Hashing',
  },

  // ─── Protocol / application formats ───────────────────────────
  { name: 'NTLM', hashcatMode: 1000, regex: /^[a-fA-F0-9]{32}$/, category: 'Operating System' },
  {
    name: 'NetNTLMv2',
    hashcatMode: 5600,
    regex: /^[a-zA-Z0-9]+::\S+:[a-fA-F0-9]{16}:[a-fA-F0-9]{32}:[a-fA-F0-9]+$/,
    category: 'Network Protocol',
  },
  {
    name: 'NetNTLMv1',
    hashcatMode: 5500,
    regex: /^[a-zA-Z0-9]+::\S+:[a-fA-F0-9]{48}:[a-fA-F0-9]{48}:[a-fA-F0-9]{16}$/,
    category: 'Network Protocol',
  },
  {
    name: 'Kerberos 5 TGS-REP (RC4)',
    hashcatMode: 13100,
    regex: /^\$krb5tgs\$23\$/,
    category: 'Network Protocol',
  },
  {
    name: 'Kerberos 5 AS-REP (RC4)',
    hashcatMode: 18200,
    regex: /^\$krb5asrep\$23\$/,
    category: 'Network Protocol',
  },
  {
    name: 'DCC2 (mscash2)',
    hashcatMode: 2100,
    regex: /^\$DCC2\$\d+#[^#]+#[a-fA-F0-9]{32}$/,
    category: 'Operating System',
  },
  { name: 'LM', hashcatMode: 3000, regex: /^[a-fA-F0-9]{32}$/, category: 'Operating System' },

  // ─── Raw hex hashes (by length, most popular first) ───────────
  { name: 'MD5', hashcatMode: 0, regex: /^[a-fA-F0-9]{32}$/, category: 'Raw Hash' },
  { name: 'SHA-1', hashcatMode: 100, regex: /^[a-fA-F0-9]{40}$/, category: 'Raw Hash' },
  { name: 'SHA-256', hashcatMode: 1400, regex: /^[a-fA-F0-9]{64}$/, category: 'Raw Hash' },
  { name: 'SHA-384', hashcatMode: 10800, regex: /^[a-fA-F0-9]{96}$/, category: 'Raw Hash' },
  { name: 'SHA-512', hashcatMode: 1700, regex: /^[a-fA-F0-9]{128}$/, category: 'Raw Hash' },
  { name: 'MD4', hashcatMode: 900, regex: /^[a-fA-F0-9]{32}$/, category: 'Raw Hash' },
  { name: 'RIPEMD-160', hashcatMode: 6000, regex: /^[a-fA-F0-9]{40}$/, category: 'Raw Hash' },
  { name: 'Whirlpool', hashcatMode: 6100, regex: /^[a-fA-F0-9]{128}$/, category: 'Raw Hash' },

  // ─── Salted / application-specific ────────────────────────────
  { name: 'MySQL 4.1+', hashcatMode: 300, regex: /^\*[A-F0-9]{40}$/, category: 'Database Server' },
  {
    name: 'Oracle H: Type (Oracle 7+)',
    hashcatMode: 3100,
    regex: /^[a-fA-F0-9]{16}$/,
    category: 'Database Server',
  },
  {
    name: 'PostgreSQL MD5',
    hashcatMode: 12,
    regex: /^md5[a-fA-F0-9]{32}$/,
    category: 'Database Server',
  },

  // ─── CRC / checksums ──────────────────────────────────────────
  { name: 'CRC32', hashcatMode: 11500, regex: /^[a-fA-F0-9]{8}$/, category: 'Checksum' },
]

export interface HashCandidate {
  name: string
  hashcatMode: number
  category: string
  confidence: number
}

/**
 * Analyzes a hash string and returns ranked candidate types.
 * Confidence scoring:
 *   - Structured/prefixed formats get high confidence (0.95) since they're unambiguous
 *   - Raw hex hashes share lengths, so confidence decreases with each match (popularity-ranked)
 */
export function guessHashType(hashValue: string): HashCandidate[] {
  const trimmed = hashValue.trim()
  if (!trimmed) {
    return []
  }

  const candidates: HashCandidate[] = []
  const seenModes = new Set<number>()

  for (const pattern of HASH_PATTERNS) {
    if (pattern.regex.test(trimmed)) {
      // Avoid duplicate mode entries
      if (seenModes.has(pattern.hashcatMode)) {
        continue
      }
      seenModes.add(pattern.hashcatMode)

      // Structured formats are near-certain; raw hex shares lengths
      const isStructured =
        trimmed.includes('$') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('md5') ||
        trimmed.includes('::')
      const baseConfidence = isStructured ? 0.95 : 0.7

      // Decay confidence for later matches of same-length raw hex
      const positionPenalty = isStructured ? 0 : candidates.length * 0.1
      const confidence = Math.max(0.1, baseConfidence - positionPenalty)

      candidates.push({
        name: pattern.name,
        hashcatMode: pattern.hashcatMode,
        category: pattern.category,
        confidence: Math.round(confidence * 100) / 100,
      })
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence)

  return candidates
}

/**
 * Looks up a hash type by its hashcat mode number in the database.
 */
export async function getHashTypeByMode(mode: number) {
  const [ht] = await db.select().from(hashTypes).where(eq(hashTypes.hashcatMode, mode)).limit(1)
  return ht ?? null
}

/**
 * Validates whether a hash string matches a known format.
 */
export function validateHashFormat(hashValue: string): boolean {
  const candidates = guessHashType(hashValue)
  return candidates.length > 0
}
