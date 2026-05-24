/**
 * Dashboard API contract tests.
 *
 * Validates auth guards and request validation on dashboard endpoints.
 * Tests middleware layer behavior without requiring a running database.
 */
import { describe, expect, it, mock } from 'bun:test'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        // Check for the BetterAuth session cookie
        const cookie = headers.get('cookie') ?? ''
        if (cookie.includes('hh.session_token=valid-session')) {
          return {
            user: {
              id: '1',
              email: 'test@example.com',
              name: 'Test User',
              emailVerified: true,
              image: null,
            },
            session: {
              id: 'sess-1',
              userId: '1',
              token: 'tok-1',
              expiresAt: new Date(Date.now() + 3600000),
            },
          }
        }
        return null
      },
    },
    handler: async () => new Response('ok'),
  },
}))

// Mock auth service functions still used by routes
mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async () => null,
  findProjectMembership: async () => null,
}))

// Mock DB
mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
        innerJoin: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  },
  client: {},
}))

// Mock queue, storage, Redis
mock.module('../../src/queue/context.js', () => ({
  getQueueManager: () => ({
    getHealth: async () => ({ status: 'connected', queues: {} }),
    init: async () => {},
    shutdown: async () => {},
  }),
  setQueueManager: () => {},
}))

mock.module('../../src/queue/manager.js', () => ({
  QueueManager: class {
    init() {
      return Promise.resolve()
    }
    shutdown() {
      return Promise.resolve()
    }
    getHealth() {
      return Promise.resolve({ status: 'connected', queues: {} })
    }
  },
}))

mock.module('../../src/config/storage.js', () => ({
  // Match the real `checkObjectStoreHealth` return shape `{status, bucket}`
  // so `probeObjectStore`'s downstream `detail.bucket` stays defined.
  checkObjectStoreHealth: async () => ({ status: 'connected', bucket: 'hashhive-test' }),
  createPresignedDownloadUrl: async () => 'http://localhost:9000/fake',
}))

mock.module('ioredis', () => ({
  default: class MockRedis {
    ping() {
      return Promise.resolve('PONG')
    }
    on() {
      return this
    }
    disconnect() {}
  },
}))

import { app } from '../../src/index.js'

const DASH_BASE = '/api/v1/dashboard'

// ─── Auth Guards ────────────────────────────────────────────────────

describe('Dashboard API: Auth guards', () => {
  const protectedRoutes = [
    { method: 'GET', path: '/projects' },
    { method: 'GET', path: '/agents' },
    { method: 'GET', path: '/campaigns' },
    { method: 'GET', path: '/resources/hash-types' },
    { method: 'GET', path: '/tasks' },
  ]

  for (const { method, path } of protectedRoutes) {
    it(`should return 401 for ${method} ${path} without session`, async () => {
      const res = await app.request(`${DASH_BASE}${path}`, { method })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body['error']).toBeDefined()
      expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID')
    })
  }
})

// ─── POST /hashes/guess-type -- Hash Type Detection ──────────────────

describe('Dashboard API: POST /hashes/guess-type', () => {
  it('should return hash type candidates for MD5', async () => {
    const res = await app.request(`${DASH_BASE}/hashes/guess-type`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({ hashValue: '5d41402abc4b2a76b9719d911017c592' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body['candidates']).toBeDefined()
    expect(Array.isArray(body['candidates'])).toBe(true)
    expect(body['candidates'].length).toBeGreaterThan(0)

    const candidate = body['candidates'][0]
    expect(typeof candidate['name']).toBe('string')
    expect(typeof candidate['hashcatMode']).toBe('number')
    expect(typeof candidate['confidence']).toBe('number')
  })

  it('should return 400 for missing hashValue', async () => {
    const res = await app.request(`${DASH_BASE}/hashes/guess-type`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// ─── POST /campaigns -- Create Campaign ──────────────────────────────

describe('Dashboard API: POST /campaigns', () => {
  it('should return 401 without session', async () => {
    const res = await app.request(`${DASH_BASE}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', projectId: 1, hashListId: 1, priority: 5 }),
    })
    expect(res.status).toBe(401)
  })
})
