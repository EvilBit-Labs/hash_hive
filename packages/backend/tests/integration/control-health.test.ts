/**
 * Integration tests for GET /api/v1/control/health (issue #109).
 *
 * The control health endpoint was refactored to delegate to the unified
 * health service. Verifies:
 *   - 401 paths: missing/invalid auth scheme and clearly malformed
 *     bearer tokens land the RFC 9457 problem-details envelope.
 *   - 200 path: a valid API key returns the SystemHealth shape with the
 *     `components` envelope (and not the public legacy `services`
 *     shape).
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test';

interface MockUserRow {
  id: number;
  email: string;
  status: string;
  apiKeyHash: string | null;
  apiKeyLastUsedAt: Date | null;
}

let mockUserRow: MockUserRow | null = null;

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockUserRow ? [mockUserRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    // Discriminate by query content so a regression that swapped
    // pg_stat_activity / pg_settings shapes (or renamed `used`/`max`)
    // would surface — a single shared shape would mask real column
    // mismatches.
    execute: async (q: unknown) => {
      const sqlText = String(q);
      if (sqlText.includes('pg_stat_activity')) return [{ used: 1 }];
      if (sqlText.includes('pg_settings')) return [{ max: 100 }];
      return [];
    },
  },
  client: {},
}));

mock.module('../../src/config/storage.js', () => ({
  checkMinioHealth: mock(() =>
    Promise.resolve({ status: 'connected' as const, bucket: 'hashhive-test' })
  ),
  s3: {},
  uploadFile: mock(),
  downloadFile: mock(),
  deleteFile: mock(),
  getPresignedUrl: mock(),
}));

import { generateApiKey } from '../../src/lib/api-key.js';
import { app } from '../../src/index.js';

describe('GET /api/v1/control/health', () => {
  it('returns 401 (RFC 9457 problem details) without an API key', async () => {
    const res = await app.request('/api/v1/control/health');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects an invalid Bearer scheme with 401 problem details', async () => {
    const res = await app.request('/api/v1/control/health', {
      headers: { authorization: 'Basic deadbeef' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects a malformed control API key with 401 problem details', async () => {
    // Token is shaped wrong on purpose (no `cst_` prefix, no userId
    // segment) so the parser rejects it before any DB lookup runs.
    // A token shaped like `Bearer cst_999_<40-byte>` would pass the
    // parser and hit a DB lookup that returns 500 in a fully-stubbed
    // unit env (CI-red), masking the parser-level test intent.
    const res = await app.request('/api/v1/control/health', {
      headers: { authorization: 'Bearer malformed-control-key' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  // PR review I-2: prior tests only covered 401 paths. Add a happy-path
  // test that drives the route through to the SystemHealth response so a
  // regression that returned the dashboard envelope shape (or an
  // arbitrary shape) on the control surface would be caught.
  describe('with a valid API key', () => {
    let validToken: string;

    beforeAll(async () => {
      const { token, hash } = await generateApiKey(42);
      validToken = token;
      mockUserRow = {
        id: 42,
        email: 'control-health-tester@example.com',
        status: 'active',
        apiKeyHash: hash,
        apiKeyLastUsedAt: null,
      };
    });

    it('returns 200 with the full SystemHealth shape', async () => {
      const res = await app.request('/api/v1/control/health', {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = (await res.json()) as {
        status: string;
        timestamp: string;
        version: string;
        components: Record<string, { status: string; durationMs: number }>;
      };
      expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
      expect(body.version).toBe('1.1.0');
      expect(typeof body.timestamp).toBe('string');
      // All four components present — same shape as the dashboard surface,
      // unlike the public /health envelope. Bracket notation per
      // `noPropertyAccessFromIndexSignature` (Record<string, …> requires
      // it).
      expect(body.components['database']).toBeDefined();
      expect(body.components['redis']).toBeDefined();
      expect(body.components['minio']).toBeDefined();
      expect(body.components['queues']).toBeDefined();
      // Per-component status uses the three-tier enum
      for (const c of Object.values(body.components)) {
        expect(['healthy', 'degraded', 'unhealthy']).toContain(c.status);
      }
    });

    it('does NOT return the legacy `services` envelope on the control surface', async () => {
      const res = await app.request('/api/v1/control/health', {
        headers: { authorization: `Bearer ${validToken}` },
      });
      const body = (await res.json()) as Record<string, unknown>;
      // Dashboard / Control: rich `components` shape.
      // Public /health: legacy `services` shape.
      // The two must not be confused — control consumers should not see `services`.
      expect(body['services']).toBeUndefined();
      expect(body['components']).toBeDefined();
    });
  });
});
