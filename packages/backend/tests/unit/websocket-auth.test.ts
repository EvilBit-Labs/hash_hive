import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
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

mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async (userId: number) => ({
    user: { id: userId, email: `user-${userId}@test.com`, name: 'Test User', status: 'active' },
    projects: [{ id: 1, name: 'Test Project', slug: 'test-project', roles: ['admin'] }],
  }),
  findProjectMembership: async () => null,
}))

import { app, websocket } from '../../src/index.js'

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: app.fetch,
    websocket,
  })
})

afterAll(() => {
  server.stop(true)
})

function wsUrl(path: string): string {
  return `ws://localhost:${server.port}${path}`
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for message')), 3000)
    ws.onmessage = (event) => {
      clearTimeout(timeout)
      resolve(JSON.parse(event.data) as Record<string, unknown>)
    }
  })
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for close')), 3000)
    ws.onclose = (event) => {
      clearTimeout(timeout)
      resolve({ code: event.code, reason: event.reason })
    }
  })
}

describe('WebSocket BetterAuth session authentication', () => {
  it('should accept a valid BetterAuth session cookie', async () => {
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream?projectIds=1'), {
      headers: { cookie: 'hh.session_token=valid-session' },
    })

    const msg = await waitForMessage(ws)
    expect(msg['type']).toBe('connected')
    expect(msg['projectIds']).toEqual([1])
    ws.close()
  })

  it('should close with 4001 when no auth is provided', async () => {
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream?projectIds=1'))
    const { code } = await waitForClose(ws)
    expect(code).toBe(4001)
  })

  it('should close with 4002 when projectIds is missing', async () => {
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'), {
      headers: { cookie: 'hh.session_token=valid-session' },
    })
    const { code } = await waitForClose(ws)
    expect(code).toBe(4002)
  })

  it('should close with 4003 when user has no access to requested projects', async () => {
    // Mock returns project id=1 only; requesting project id=999 should fail
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream?projectIds=999'), {
      headers: { cookie: 'hh.session_token=valid-session' },
    })
    const { code } = await waitForClose(ws)
    expect(code).toBe(4003)
  })
})
