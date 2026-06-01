/**
 * Integration smoke tests for the complete HashHive API.
 *
 * These tests validate the full request/response cycle through the
 * Hono app without requiring a running database. They verify that
 * routing, middleware, and validation work end-to-end.
 *
 * Authenticated tests requiring BetterAuth sessions need a running DB
 * and live in the per-route `tests/unit/dashboard-*-routes.test.ts`
 * files, which use module-scoped `mock.module('../../src/lib/auth.js')`
 * stubs to bypass the real BetterAuth handshake. This smoke suite
 * stays anonymous-only so it can run without that mock plumbing.
 */
import { describe, expect, it, mock } from 'bun:test'

// Mock BetterAuth to avoid DB dependency in smoke tests
mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async () => null,
    },
    handler: async () => new Response('ok'),
  },
}))

import { app } from '../../src/index.js'

describe('Integration: Health check', () => {
  it('should return health status with all expected fields', async () => {
    const res = await app.request('/health')
    // Issue #109: /health returns 503 when system is unhealthy (e.g. Redis
    // unreachable in test env), 200 otherwise. Body shape is identical.
    expect([200, 503]).toContain(res.status)

    const body = await res.json()
    expect(['ok', 'degraded']).toContain(body['status'])
    expect(body['version']).toBe('2.0.0')
    expect(typeof body['timestamp']).toBe('string')

    // Validate ISO 8601 timestamp
    const date = new Date(body['timestamp'])
    expect(date.toISOString()).toBe(body['timestamp'])
  })
})

describe('Integration: Agent workflow validation', () => {
  it('should enforce auth on all agent endpoints', async () => {
    const endpoints = [
      { method: 'POST', path: '/api/v1/agent/heartbeat' },
      { method: 'POST', path: '/api/v1/agent/tasks/next' },
      { method: 'POST', path: '/api/v1/agent/tasks/1/report' },
      { method: 'POST', path: '/api/v1/agent/errors' },
      { method: 'POST', path: '/api/v1/agent/cracker/check-update' },
    ]

    for (const { method, path } of endpoints) {
      const res = await app.request(path, { method })
      expect(res.status).toBe(401)
    }
  })

  it('should return 404 for removed /sessions endpoint', async () => {
    const res = await app.request('/api/v1/agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('Integration: Dashboard workflow validation', () => {
  it('should enforce session auth on all dashboard endpoints', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/v1/dashboard/projects' },
      { method: 'GET', path: '/api/v1/dashboard/agents' },
      { method: 'GET', path: '/api/v1/dashboard/campaigns' },
      { method: 'GET', path: '/api/v1/dashboard/tasks' },
      { method: 'GET', path: '/api/v1/dashboard/resources/hash-types' },
      { method: 'GET', path: '/api/v1/dashboard/crackers' },
    ]

    for (const { method, path } of endpoints) {
      const res = await app.request(path, { method })
      expect(res.status).toBe(401)
    }
  })
})

describe('Integration: Cross-cutting concerns', () => {
  it('should return request ID in response headers', async () => {
    const res = await app.request('/health')
    const requestId = res.headers.get('x-request-id')
    expect(requestId).toBeDefined()
    expect(typeof requestId).toBe('string')
  })

  it('should respect custom request ID header', async () => {
    const customId = 'test-request-123'
    const res = await app.request('/health', {
      headers: { 'x-request-id': customId },
    })
    expect(res.headers.get('x-request-id')).toBe(customId)
  })

  it('should return structured 404 for unknown routes', async () => {
    const res = await app.request('/api/v1/nonexistent')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body['error']['code']).toBe('NOT_FOUND')
  })

  it('should include security headers', async () => {
    const res = await app.request('/health')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBeDefined()
  })
})
