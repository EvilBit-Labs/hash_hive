import { describe, expect, test } from 'bun:test'

import {
  guessHashType,
  guessTopHashType,
  validateHashFormat,
} from '../../src/services/hash-analysis.js'

describe('guessHashType', () => {
  test('should identify MD5 hash', () => {
    const candidates = guessHashType('5d41402abc4b2a76b9719d911017c592')
    const md5 = candidates.find((c) => c.name === 'MD5')
    expect(md5).toBeDefined()
    expect(md5!.hashcatMode).toBe(0)
    expect(md5!.category).toBe('Raw Hash')
  })

  test('should identify SHA-1 hash', () => {
    const candidates = guessHashType('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
    const sha1 = candidates.find((c) => c.name === 'SHA-1')
    expect(sha1).toBeDefined()
    expect(sha1!.hashcatMode).toBe(100)
  })

  test('should identify SHA-256 hash', () => {
    const candidates = guessHashType(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
    const sha256 = candidates.find((c) => c.name === 'SHA-256')
    expect(sha256).toBeDefined()
    expect(sha256!.hashcatMode).toBe(1400)
  })

  test('should identify SHA-512 hash', () => {
    const hash =
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'
    const candidates = guessHashType(hash)
    const sha512 = candidates.find((c) => c.name === 'SHA-512')
    expect(sha512).toBeDefined()
    expect(sha512!.hashcatMode).toBe(1700)
  })

  test('should identify bcrypt hash with high confidence', () => {
    const candidates = guessHashType('$2b$12$WApznUPhDubN0oeveSXHp.Ux5KijMo/Hkb3Gf/.GfCVyhPMHO2G.6')
    expect(candidates.length).toBe(1)
    expect(candidates[0]!.name).toBe('bcrypt')
    expect(candidates[0]!.hashcatMode).toBe(3200)
    expect(candidates[0]!.confidence).toBeGreaterThanOrEqual(0.9)
  })

  test('should identify MD5 Crypt hash', () => {
    const candidates = guessHashType('$1$salt1234$mdOnJkrqjR9gYMW7HMJgk.')
    const md5crypt = candidates.find((c) => c.name === 'MD5 Crypt')
    expect(md5crypt).toBeDefined()
    expect(md5crypt!.hashcatMode).toBe(500)
  })

  test('should identify MySQL 4.1+ hash', () => {
    const candidates = guessHashType('*6C8989366EAF6BCBBAA855D6DA0A81E8D9D47382')
    expect(candidates[0]!.name).toBe('MySQL 4.1+')
    expect(candidates[0]!.hashcatMode).toBe(300)
  })

  test('should return multiple candidates for ambiguous 32-char hex', () => {
    // 32-char hex could be MD5, NTLM, MD4, or LM
    const candidates = guessHashType('5d41402abc4b2a76b9719d911017c592')
    expect(candidates.length).toBeGreaterThan(1)

    const names = candidates.map((c) => c.name)
    expect(names).toContain('MD5')
    expect(names).toContain('NTLM')
  })

  test('should rank structured formats higher than raw hex', () => {
    const bcryptCandidates = guessHashType(
      '$2b$12$WApznUPhDubN0oeveSXHp.Ux5KijMo/Hkb3Gf/.GfCVyhPMHO2G.6'
    )
    const md5Candidates = guessHashType('5d41402abc4b2a76b9719d911017c592')

    expect(bcryptCandidates[0]!.confidence).toBeGreaterThan(md5Candidates[0]!.confidence)
  })

  test('should return empty array for invalid input', () => {
    expect(guessHashType('')).toEqual([])
    expect(guessHashType('not-a-hash!')).toEqual([])
    expect(guessHashType('zzz')).toEqual([])
  })
})

describe('guessTopHashType', () => {
  test('returns a structured format at 0.95 before scanning raw-hex patterns', () => {
    const guess = guessTopHashType('$2b$12$WApznUPhDubN0oeveSXHp.Ux5KijMo/Hkb3Gf/.GfCVyhPMHO2G.6')
    expect(guess).not.toBeNull()
    expect(guess!.hashcatMode).toBe(3200)
    expect(guess!.confidence).toBe(0.95)
  })

  test('returns the top popularity-ordered raw-hex mode for 32-hex', () => {
    // 32-hex matches NTLM (mode 1000) first in popularity order — same as guessHashType's top.
    const guess = guessTopHashType('5d41402abc4b2a76b9719d911017c592')
    expect(guess).not.toBeNull()
    expect(guess!.hashcatMode).toBe(1000)
    expect(guess!.confidence).toBe(0.7)
  })

  test('identifies a structured SHA-512 Crypt sample', () => {
    const guess = guessTopHashType(
      '$6$rounds=5000$salt$IxDD3jSAdZ8mH8m.g8k3lM.WQ9tD0eXfDf1z1L3PRr5rq0aQ0K6xk0f7c9r0Rk8cRj0k2Yk2Yk2Yk2Yk2Yk2Y1'
    )
    expect(guess).not.toBeNull()
    expect(guess!.hashcatMode).toBe(1800)
    expect(guess!.confidence).toBe(0.95)
  })

  test('returns null for empty and unrecognized input', () => {
    expect(guessTopHashType('')).toBeNull()
    expect(guessTopHashType('   ')).toBeNull()
    expect(guessTopHashType('not-a-hash!')).toBeNull()
    expect(guessTopHashType('zzz')).toBeNull()
  })

  test('agrees with guessHashType top candidate across a representative sample', () => {
    const samples = [
      '5d41402abc4b2a76b9719d911017c592', // 32-hex -> NTLM
      'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', // 40-hex -> SHA-1
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', // 64-hex
      '$2b$12$WApznUPhDubN0oeveSXHp.Ux5KijMo/Hkb3Gf/.GfCVyhPMHO2G.6', // bcrypt
      '$1$salt1234$mdOnJkrqjR9gYMW7HMJgk.', // MD5 Crypt
      '*6C8989366EAF6BCBBAA855D6DA0A81E8D9D47382', // MySQL 4.1+
      '', // empty
      'garbage', // unrecognized
    ]
    for (const sample of samples) {
      expect(guessTopHashType(sample)?.hashcatMode).toBe(guessHashType(sample)[0]?.hashcatMode)
    }
  })
})

describe('validateHashFormat', () => {
  test('should return true for valid hash formats', () => {
    expect(validateHashFormat('5d41402abc4b2a76b9719d911017c592')).toBe(true)
    expect(validateHashFormat('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')).toBe(true)
  })

  test('should return false for invalid strings', () => {
    expect(validateHashFormat('hello world')).toBe(false)
    expect(validateHashFormat('')).toBe(false)
  })
})
