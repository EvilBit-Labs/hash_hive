import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'

// Shrink the WS upgrade handler's per-call timeout so the hang tests
// don't have to wait the full 10s default. Must be set before the
// `import { app, websocket } from '../../src/index.js'` below since
// events.ts captures the value at module load.
process.env['HH_WS_AUTH_TIMEOUT_MS'] = '250'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? ''
        if (cookie.includes('hh.session_token=hang-auth')) {
          // Simulate a hung BetterAuth lookup so the upgrade handler's
          // withTimeout wrapper fires. Never resolves.
          return await new Promise(() => {})
        }
        if (cookie.includes('hh.session_token=hang-membership')) {
          // Resolves quickly so the handler proceeds to the membership
          // lookup, which is the one that should time out below.
          // userId 4242 + projectId 4242 is the membership-hang
          // sentinel wired into the findProjectMembership mock.
          return {
            user: {
              id: '4242',
              email: 'hang-mem@test.com',
              name: 'Hang Membership User',
              emailVerified: true,
              image: null,
            },
            session: {
              id: 'sess-hang-mem',
              userId: '4242',
              token: 'tok-hang-mem',
              expiresAt: new Date(Date.now() + 3600000),
              projectId: 4242,
            },
          }
        }
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
              projectId: 1, // server-managed project context
            },
          }
        }
        if (cookie.includes('hh.session_token=no-project-session')) {
          return {
            user: {
              id: '2',
              email: 'noproject@example.com',
              name: 'No Project User',
              emailVerified: true,
              image: null,
            },
            session: {
              id: 'sess-2',
              userId: '2',
              token: 'tok-2',
              expiresAt: new Date(Date.now() + 3600000),
              // projectId intentionally omitted: multi-project user
              // pre-selector
            },
          }
        }
        if (cookie.includes('hh.session_token=revoked-membership')) {
          return {
            user: {
              id: '3',
              email: 'revoked@example.com',
              name: 'Revoked User',
              emailVerified: true,
              image: null,
            },
            session: {
              id: 'sess-3',
              userId: '3',
              token: 'tok-3',
              expiresAt: new Date(Date.now() + 3600000),
              projectId: 999, // membership for this project was revoked
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
  findProjectMembership: async (userId: number, projectId: number) => {
    // Test scenarios: userId 1 has membership in project 1; userId 3's
    // membership for project 999 was revoked; everything else is null.
    // userId 4242 / projectId 4242 is the membership-hang sentinel
    // used by the timeout test (never resolves so the upgrade
    // handler's withTimeout wrapper fires).
    if (userId === 4242 && projectId === 4242) {
      return await new Promise(() => {})
    }
    if (userId === 1 && projectId === 1) {
      return { userId, projectId, roles: ['admin'] }
    }
    return null
  },
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
  it('should accept a session with a server-managed projectId', async () => {
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'), {
      headers: { cookie: 'hh.session_token=valid-session' },
    })

    const msg = await waitForMessage(ws)
    expect(msg['type']).toBe('connected')
    expect(msg['projectId']).toBe(1)
    ws.close()
  })

  it('should close with 4001 when no auth is provided', async () => {
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'))
    const { code } = await waitForClose(ws)
    expect(code).toBe(4001)
  })

  it('should close with 4002 when session has no projectId', async () => {
    // Multi-project user pre-selector: session exists but projectId is
    // undefined. Frontend must call POST /projects/select first.
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'), {
      headers: { cookie: 'hh.session_token=no-project-session' },
    })
    const { code } = await waitForClose(ws)
    expect(code).toBe(4002)
  })

  it('should close with 4003 when membership for session project was revoked', async () => {
    // userId=3 had session.projectId=999 written at sign-in but their
    // membership was revoked. The defense-in-depth membership check at
    // upgrade time catches this and closes 4003.
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'), {
      headers: { cookie: 'hh.session_token=revoked-membership' },
    })
    const { code } = await waitForClose(ws)
    expect(code).toBe(4003)
  })

  it('should ignore any projectIds query parameter (removed from contract)', async () => {
    // Sending the removed query param does not change scoping: the
    // session field is the source of truth. The connection still opens
    // with the session's projectId.
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream?projectIds=2,3,4'), {
      headers: { cookie: 'hh.session_token=valid-session' },
    })
    const msg = await waitForMessage(ws)
    expect(msg['type']).toBe('connected')
    expect(msg['projectId']).toBe(1)
    ws.close()
  })

  it('should close with 4001 when BetterAuth getSession hangs past the timeout', async () => {
    // A hung auth backend must not strand the upgrade indefinitely:
    // the withTimeout wrapper rejects, the .catch coerces to null, and
    // the existing missing-auth path closes 4001 so the frontend's
    // auth-refresh flow takes over.
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'), {
      headers: { cookie: 'hh.session_token=hang-auth' },
    })
    const { code } = await waitForClose(ws)
    expect(code).toBe(4001)
  })

  it('should close with 4500 when findProjectMembership hangs past the timeout', async () => {
    // A hung membership lookup must close 4500 (not 4003): 4003 means
    // "membership revoked" and would mislead the frontend; 4500 lands
    // in the retry-budget path so a transient outage recovers without
    // looking like an authorization failure.
    const ws = new WebSocket(wsUrl('/api/v1/dashboard/events/stream'), {
      headers: { cookie: 'hh.session_token=hang-membership' },
    })
    const { code } = await waitForClose(ws)
    expect(code).toBe(4500)
  })
})
