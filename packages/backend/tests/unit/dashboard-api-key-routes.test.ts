import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface UserState {
  id: number
  apiKeyHash: string | null
  apiKeyLastUsedAt: Date | null
}

let mockUser: UserState | null = null

const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () =>
          Promise.resolve(
            mockUser
              ? [
                  {
                    apiKeyHash: mockUser.apiKeyHash,
                    apiKeyLastUsedAt: mockUser.apiKeyLastUsedAt,
                  },
                ]
              : []
          ),
      }),
    }),
  }),
  update: () => ({
    set: (patch: { apiKeyHash?: string | null; apiKeyLastUsedAt?: Date | null }) => ({
      where: () => {
        if (!mockUser) return Promise.resolve()
        if (patch.apiKeyHash !== undefined) mockUser.apiKeyHash = patch.apiKeyHash
        if (patch.apiKeyLastUsedAt !== undefined) {
          mockUser.apiKeyLastUsedAt = patch.apiKeyLastUsedAt
        }
        return Promise.resolve()
      },
    }),
  }),
}

mock.module('../../src/db/index.js', () => ({ db: dbMock, client: {} }))

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async () =>
        mockUser
          ? {
              user: {
                id: String(mockUser.id),
                email: 'admin@example.com',
                name: 'Admin',
                emailVerified: true,
                image: null,
              },
              session: {
                id: 's',
                userId: String(mockUser.id),
                token: 't',
                expiresAt: new Date(Date.now() + 3600000),
              },
            }
          : null,
    },
    handler: async () => new Response('ok'),
  },
}))

import { authRoutes } from '../../src/routes/dashboard/auth.js'

describe('dashboard /me/api-key routes', () => {
  beforeEach(() => {
    mockUser = { id: 42, apiKeyHash: null, apiKeyLastUsedAt: null }
  })

  it('GET reports hasKey false when none exists', async () => {
    const res = await authRoutes.request('/me/api-key')
    expect(res.status).toBe(200)
    const body = await res.json()
    // Discriminated union: hasKey:false carries no other fields (the
    // discriminator alone is sufficient — no prefix or lastUsedAt to
    // surface when there is no key).
    expect(body).toEqual({ hasKey: false })
  })

  it('POST issues a new key and returns the raw token once', async () => {
    const res = await authRoutes.request('/me/api-key', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toMatch(/^cst_42_/)
    expect(body.metadata.hasKey).toBe(true)
    expect(body.metadata.prefix).toMatch(/^cst_42_…$/)
    expect(body.metadata.lastUsedAt).toBeNull()
    expect(mockUser?.apiKeyHash).not.toBeNull()
  })

  it('POST rotation replaces the previous hash', async () => {
    const first = await (await authRoutes.request('/me/api-key', { method: 'POST' })).json()
    const firstHash = mockUser?.apiKeyHash
    const second = await (await authRoutes.request('/me/api-key', { method: 'POST' })).json()
    expect(first.token).not.toBe(second.token)
    expect(mockUser?.apiKeyHash).not.toBe(firstHash)
  })

  it('DELETE revokes the key', async () => {
    await authRoutes.request('/me/api-key', { method: 'POST' })
    expect(mockUser?.apiKeyHash).not.toBeNull()
    const res = await authRoutes.request('/me/api-key', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(mockUser?.apiKeyHash).toBeNull()
  })

  it('GET reports lastUsedAt when set', async () => {
    if (mockUser) mockUser.apiKeyHash = 'hash'
    if (mockUser) mockUser.apiKeyLastUsedAt = new Date('2026-01-01T00:00:00Z')
    const res = await authRoutes.request('/me/api-key')
    const body = await res.json()
    expect(body.hasKey).toBe(true)
    expect(body.lastUsedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns 401 when there is no session', async () => {
    mockUser = null
    const res = await authRoutes.request('/me/api-key')
    expect(res.status).toBe(401)
  })
})
