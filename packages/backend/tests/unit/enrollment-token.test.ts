import { describe, expect, test } from 'bun:test'

import {
  ENROLLMENT_TOKEN_PREFIX,
  generateEnrollmentToken,
  parseEnrollmentToken,
  verifyEnrollmentTokenHash,
} from '../../src/lib/enrollment-token.js'

// Shape of the generated secret: adjective-color-animal-NN (4 segments,
// hyphen-joined, lowercase, two-digit numeric suffix). Mirrors the
// dictionaries documented in enrollment-token.ts.
const SECRET_SHAPE = /^[a-z]+-[a-z]+-[a-z]+-\d{2}$/

describe('generateEnrollmentToken', () => {
  test('returns a token with the etk prefix and the tokenId hint', async () => {
    const { token, hash } = await generateEnrollmentToken(7)
    expect(token.startsWith(`${ENROLLMENT_TOKEN_PREFIX}_7_`)).toBe(true)
    expect(hash.length).toBeGreaterThan(0)
  })

  test('embeds a well-formed word-phrase secret', async () => {
    const { token } = await generateEnrollmentToken(7)
    const parsed = parseEnrollmentToken(token)
    expect(parsed).not.toBeNull()
    expect(parsed?.tokenId).toBe(7)
    expect(parsed?.secret).toMatch(SECRET_SHAPE)
  })

  test('produces a hash that verifies against the issued secret', async () => {
    const { token, hash } = await generateEnrollmentToken(3)
    const parsed = parseEnrollmentToken(token)
    expect(parsed).not.toBeNull()
    expect(await verifyEnrollmentTokenHash(parsed!.secret, hash)).toBe(true)
  })

  test('produces fresh randomness across calls', async () => {
    const a = await generateEnrollmentToken(1)
    const b = await generateEnrollmentToken(1)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).not.toBe(b.hash)
  })

  test('hash does not contain the raw secret (not reversible by substring)', async () => {
    const { token, hash } = await generateEnrollmentToken(99)
    const parsed = parseEnrollmentToken(token)
    expect(hash).not.toContain(parsed!.secret)
  })
})

describe('parseEnrollmentToken', () => {
  test('returns tokenId and secret for a well-formed token', () => {
    expect(parseEnrollmentToken('etk_42_brave-coral-otter-47')).toEqual({
      tokenId: 42,
      secret: 'brave-coral-otter-47',
    })
  })

  test('returns null for wrong prefix (agent/control tokens)', () => {
    expect(parseEnrollmentToken('agt_42_abc123')).toBeNull()
    expect(parseEnrollmentToken('cst_1_xyz')).toBeNull()
  })

  test('returns null for malformed tokenId', () => {
    expect(parseEnrollmentToken('etk_0_brave-coral')).toBeNull()
    expect(parseEnrollmentToken('etk_-1_brave-coral')).toBeNull()
    expect(parseEnrollmentToken('etk_abc_brave-coral')).toBeNull()
    expect(parseEnrollmentToken('etk_1.5_brave-coral')).toBeNull()
    expect(parseEnrollmentToken('etk_01_brave-coral')).toBeNull()
  })

  test('returns null for missing secret', () => {
    expect(parseEnrollmentToken('etk_42_')).toBeNull()
    expect(parseEnrollmentToken('etk_42')).toBeNull()
  })

  test('returns null for empty input', () => {
    expect(parseEnrollmentToken('')).toBeNull()
  })

  test('rejects tokenIds beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993' // MAX_SAFE_INTEGER + 2
    expect(parseEnrollmentToken(`etk_${huge}_brave-coral`)).toBeNull()
  })
})

describe('verifyEnrollmentTokenHash', () => {
  test('returns false for empty secret', async () => {
    expect(await verifyEnrollmentTokenHash('', 'somehash')).toBe(false)
  })

  test('returns false for empty hash', async () => {
    expect(await verifyEnrollmentTokenHash('brave-coral-otter-47', '')).toBe(false)
  })

  test('returns false (not throws) for malformed hash', async () => {
    expect(await verifyEnrollmentTokenHash('brave-coral-otter-47', 'not-a-bcrypt-hash')).toBe(false)
  })

  test('returns false for a wrong but well-formed secret', async () => {
    const { hash } = await generateEnrollmentToken(1)
    expect(await verifyEnrollmentTokenHash('wrong-secret-phrase-99', hash)).toBe(false)
  })
})
