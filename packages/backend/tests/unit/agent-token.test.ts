import { describe, expect, test } from 'bun:test'

import {
  AGENT_TOKEN_PREFIX,
  generateAgentToken,
  parseAgentToken,
  verifyAgentTokenHash,
} from '../../src/lib/agent-token.js'

describe('generateAgentToken', () => {
  test('returns a token with the agt prefix and the agentId hint', async () => {
    const { token, hash } = await generateAgentToken(42)
    expect(token.startsWith(`${AGENT_TOKEN_PREFIX}_42_`)).toBe(true)
    expect(hash.length).toBeGreaterThan(0)
    expect(hash).not.toContain(token)
  })

  test('produces a verifiable hash for the issued token', async () => {
    const { token, hash } = await generateAgentToken(7)
    expect(await verifyAgentTokenHash(token, hash)).toBe(true)
  })

  test('produces fresh randomness across calls', async () => {
    const a = await generateAgentToken(1)
    const b = await generateAgentToken(1)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).not.toBe(b.hash)
  })

  test('hash never contains the raw token (cannot be reversed by substring)', async () => {
    const { token, hash } = await generateAgentToken(99)
    expect(hash).not.toContain(token)
  })
})

describe('parseAgentToken', () => {
  test('returns agentId and remainder for a well-formed token', () => {
    const parsed = parseAgentToken('agt_42_abc123')
    expect(parsed).toEqual({ agentId: 42, remainder: 'abc123' })
  })

  test('returns null for wrong prefix (legacy plaintext UUIDs)', () => {
    expect(parseAgentToken('a1b2c3d4-1234-5678-90ab-cdef01234567')).toBeNull()
    expect(parseAgentToken('cst_1_xyz')).toBeNull()
  })

  test('returns null for malformed agentId', () => {
    expect(parseAgentToken('agt_0_xyz')).toBeNull()
    expect(parseAgentToken('agt_-1_xyz')).toBeNull()
    expect(parseAgentToken('agt_abc_xyz')).toBeNull()
    expect(parseAgentToken('agt_1.5_xyz')).toBeNull()
  })

  test('returns null for missing remainder', () => {
    expect(parseAgentToken('agt_42_')).toBeNull()
    expect(parseAgentToken('agt_42')).toBeNull()
  })

  test('returns null for empty input', () => {
    expect(parseAgentToken('')).toBeNull()
  })

  test('rejects agentIds beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993' // MAX_SAFE_INTEGER + 2
    expect(parseAgentToken(`agt_${huge}_xyz`)).toBeNull()
  })
})

describe('verifyAgentTokenHash', () => {
  test('returns false for empty token', async () => {
    expect(await verifyAgentTokenHash('', 'somehash')).toBe(false)
  })

  test('returns false for empty hash', async () => {
    expect(await verifyAgentTokenHash('agt_1_xyz', '')).toBe(false)
  })

  test('returns false (not throws) for malformed hash', async () => {
    expect(await verifyAgentTokenHash('agt_1_xyz', 'not-a-bcrypt-hash')).toBe(false)
  })

  test('returns false for a wrong but well-formed token', async () => {
    const { hash } = await generateAgentToken(1)
    expect(await verifyAgentTokenHash('agt_1_definitely-not-the-right-token', hash)).toBe(false)
  })
})
