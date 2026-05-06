import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { mapZodError, problemResponse } from '../../src/lib/problem-details.js';
import type { AppEnv } from '../../src/types.js';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

function makeApp(handler: (c: Parameters<Parameters<typeof app.get>[1]>[0]) => Response) {
  const app = new Hono<AppEnv>();
  app.get('/x', handler);
  return app;
}

describe('problemResponse', () => {
  test('returns RFC9457 envelope with all required fields', async () => {
    const app = makeApp((c) => problemResponse(c, 400, 'validation', 'bad input'));
    const res = await app.request('/x');

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);

    const body = await res.json();
    expect(body.title).toBe('Validation failed');
    expect(body.status).toBe(400);
    expect(body.detail).toBe('bad input');
    expect(body.instance).toBe('/x');
    expect(body.type).toBe('https://hashhive.dev/errors/validation');
  });

  test('omits errors[] when not provided', async () => {
    const app = makeApp((c) => problemResponse(c, 401, 'auth', 'no token'));
    const body = await (await app.request('/x')).json();
    expect(body.errors).toBeUndefined();
  });

  test('includes errors[] when provided', async () => {
    const app = makeApp((c) =>
      problemResponse(c, 400, 'validation', 'bad input', [
        { path: 'name', code: 'too_short', message: 'min 1' },
      ])
    );
    const body = await (await app.request('/x')).json();
    expect(body.errors).toEqual([{ path: 'name', code: 'too_short', message: 'min 1' }]);
  });

  test('falls back to about:blank for unknown codes', async () => {
    const app = makeApp((c) => problemResponse(c, 500, 'mystery' as 'internal', 'something broke'));
    const body = await (await app.request('/x')).json();
    expect(body.type).toBe('about:blank');
  });

  test('emits project_not_selected envelope', async () => {
    const app = makeApp((c) =>
      problemResponse(c, 400, 'project_not_selected', 'no project header')
    );
    const body = await (await app.request('/x')).json();
    expect(body.type).toBe('https://hashhive.dev/errors/project-not-selected');
    expect(body.title).toBe('Project not selected');
  });

  test('emits service_unavailable envelope for queue failures', async () => {
    const app = makeApp((c) => problemResponse(c, 503, 'service_unavailable', 'queue is down'));
    const body = await (await app.request('/x')).json();
    expect(body.type).toBe('https://hashhive.dev/errors/service-unavailable');
    expect(body.title).toBe('Service unavailable');
    expect(body.status).toBe(503);
  });

  test('uses request path as instance', async () => {
    const app = new Hono<AppEnv>();
    app.get('/api/v1/control/foo', (c) => problemResponse(c, 404, 'not_found', 'resource missing'));
    const body = await (await app.request('/api/v1/control/foo')).json();
    expect(body.instance).toBe('/api/v1/control/foo');
  });
});

describe('mapZodError', () => {
  test('flattens issues with dotted paths', () => {
    const schema = z.object({
      name: z.string().min(1),
      age: z.number().int().min(0),
    });
    const parsed = schema.safeParse({ name: '', age: -1 });
    if (parsed.success) throw new Error('expected schema to fail');

    const errors = mapZodError(parsed.error);
    expect(errors).toHaveLength(2);
    expect(errors[0].path).toBe('name');
    expect(errors[1].path).toBe('age');
    expect(errors.every((e) => typeof e.code === 'string')).toBe(true);
    expect(errors.every((e) => typeof e.message === 'string')).toBe(true);
  });

  test('joins nested paths with dots', () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const parsed = schema.safeParse({ user: { email: 'not-an-email' } });
    if (parsed.success) throw new Error('expected schema to fail');

    const errors = mapZodError(parsed.error);
    expect(errors[0].path).toBe('user.email');
  });

  test('handles top-level errors with empty path', () => {
    const schema = z.string();
    const parsed = schema.safeParse(123);
    if (parsed.success) throw new Error('expected schema to fail');

    const errors = mapZodError(parsed.error);
    expect(errors[0].path).toBe('');
  });
});
