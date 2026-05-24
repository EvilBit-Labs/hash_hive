import { describe, expect, it } from 'bun:test'

describe('password hashing (Bun.password)', () => {
  it('should hash and verify a password', async () => {
    const password = 'my-secret-password'
    const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })

    expect(hash).not.toBe(password)
    expect(hash.startsWith('$2b$12$')).toBe(true)
    expect(await Bun.password.verify(password, hash)).toBe(true)
  })

  it('should reject an incorrect password', async () => {
    const hash = await Bun.password.hash('correct-password', { algorithm: 'bcrypt', cost: 12 })
    expect(await Bun.password.verify('wrong-password', hash)).toBe(false)
  })

  it('should produce bcrypt $2b$ hashes compatible with BetterAuth', async () => {
    const hash = await Bun.password.hash('test-password', { algorithm: 'bcrypt', cost: 12 })
    // BetterAuth stores passwords in ba_accounts.password using the same hash function.
    // Verify the hash format is standard bcrypt ($2b$ prefix, 60 chars).
    expect(hash).toMatch(/^\$2b\$12\$.{53}$/)
  })
})
