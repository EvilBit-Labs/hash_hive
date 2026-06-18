import { enrollAgentResponseSchema } from '@hashhive/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * #233 / #114 U4 — anonymous agent enrollment endpoint contract tests.
 *
 * Validates the `POST /api/v1/agent/enroll` route: it is reachable with
 * NO bearer token (anonymous by omission), returns the agent error
 * envelope `{ error: { code, message } }` on every failure path, maps
 * rejection reasons to the documented statuses (invalid -> 401, expired /
 * exhausted -> 410), and sets `Cache-Control: no-store` on the bearer-
 * bearing response.
 *
 * Runs in an isolated bun:test phase (ENROLL_ROUTE_TEST_ISOLATED=1)
 * because the `mock.module` calls replace the enrollment service, db, and
 * logger process-wide. Mirrors the env-gate + skip-stub pattern in
 * tests/unit/services/preemption.test.ts.
 *
 * The enrollment service is mocked (its own logic is covered by
 * tests/unit/services/enrollment-tokens.test.ts); the mock is pinned to
 * the service's real ReturnType per
 * docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md.
 */
import type { claimEnrollmentToken as ClaimFn } from '../../src/services/enrollment-tokens.js'

const IS_ISOLATED = process.env['ENROLL_ROUTE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('agent-enroll-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[agent-enroll-routes] skipped — set ENROLL_ROUTE_TEST_ISOLATED=1 to run; the enroll route suite did NOT execute in this phase.'
      )
      expect(process.env['ENROLL_ROUTE_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  type ClaimResult = Awaited<ReturnType<typeof ClaimFn>>

  let claimResult: ClaimResult = { ok: true, agentId: 1, token: 'agt_1_x' }
  let lastClaimArg: unknown = null
  const claimMock = mock((arg: unknown) => {
    lastClaimArg = arg
    return Promise.resolve(claimResult)
  })

  mock.module('../../src/services/enrollment-tokens.js', () => ({
    claimEnrollmentToken: claimMock,
  }))
  mock.module('../../src/db/index.js', () => ({ db: {}, client: {} }))
  mock.module('../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  const { agentRoutes } = await import('../../src/routes/agent/index.js')
  const app = new OpenAPIHono()
  app.route('/api/v1/agent', agentRoutes)

  const ENROLL = '/api/v1/agent/enroll'
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(ENROLL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const validBody = { token: 'etk_1_brave-coral-otter-47', clientId: 'rig-a', name: 'rig-a' }

  beforeEach(() => {
    claimMock.mockClear()
    lastClaimArg = null
    claimResult = { ok: true, agentId: 1, token: 'agt_1_x' }
  })

  // Agent envelope must be exactly { error: { code, message } } — no
  // dashboard-style timestamp/requestId leakage.
  async function expectAgentEnvelope(res: Response, code: string): Promise<void> {
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['error'])
    const err = body['error'] as Record<string, unknown>
    expect(err['code']).toBe(code)
    expect(typeof err['message']).toBe('string')
    expect(err).not.toHaveProperty('timestamp')
    expect(err).not.toHaveProperty('requestId')
  }

  describe('POST /enroll', () => {
    it('is reachable with no bearer token and enrolls a new agent (201, no-store)', async () => {
      claimResult = { ok: true, agentId: 42, token: 'agt_42_rand' }
      const res = await post(validBody) // deliberately no Authorization header
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toEqual({ agentId: 42, token: 'agt_42_rand' })
      // @hono/zod-openapi response schemas are compile-time only; round-trip
      // the live body through the shared schema to catch handler/schema drift.
      expect(() => enrollAgentResponseSchema.parse(body)).not.toThrow()
      expect(res.headers.get('cache-control')).toBe('no-store')
      // Service received the parsed enrollment input.
      expect(lastClaimArg).toMatchObject({ rawToken: validBody.token, clientId: 'rig-a' })
    })

    it('rejects an invalid/revoked token with 401 and a uniform envelope', async () => {
      claimResult = { ok: false, reason: 'invalid' }
      const res = await post(validBody)
      expect(res.status).toBe(401)
      expect(res.headers.get('cache-control')).toBe('no-store')
      await expectAgentEnvelope(res, 'ENROLLMENT_REJECTED')
    })

    it('maps an expired token to 410', async () => {
      claimResult = { ok: false, reason: 'expired' }
      const res = await post(validBody)
      expect(res.status).toBe(410)
      await expectAgentEnvelope(res, 'ENROLLMENT_EXPIRED')
    })

    it('maps an exhausted token to 410', async () => {
      claimResult = { ok: false, reason: 'exhausted' }
      const res = await post(validBody)
      expect(res.status).toBe(410)
      await expectAgentEnvelope(res, 'ENROLLMENT_EXHAUSTED')
    })

    it('returns the validation envelope when clientId is missing', async () => {
      const res = await post({ token: 'etk_1_x' })
      expect(res.status).toBe(400)
      await expectAgentEnvelope(res, 'VALIDATION_ERROR')
      expect(claimMock).not.toHaveBeenCalled()
    })

    it('returns the validation envelope when token is missing', async () => {
      const res = await post({ clientId: 'rig-a' })
      expect(res.status).toBe(400)
      await expectAgentEnvelope(res, 'VALIDATION_ERROR')
      expect(claimMock).not.toHaveBeenCalled()
    })
  })
}
