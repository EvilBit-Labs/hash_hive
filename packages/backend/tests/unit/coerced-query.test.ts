import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
/**
 * Tests for the coerce+catch+default+openapi pagination helpers.
 *
 * Two contracts to pin:
 *
 *   1. **Runtime parsing.** `?limit=abc` falls back to the default
 *      instead of 400-ing; the optional-positive variant maps malformed
 *      input to `undefined` instead of 400-ing. This is the whole
 *      reason the helpers exist — they package the `.catch().default()`
 *      semantics every dashboard list endpoint relies on for
 *      permissive pagination.
 *
 *   2. **Spec generation.** The `.openapi({type:'integer', ...})`
 *      annotation must be present on the emitted route property,
 *      because the `zod-to-openapi` generator cannot introspect
 *      through Zod 4's `ZodCatch` wrapper without it. A future
 *      Zod / `@hono/zod-openapi` bump that subtly changes wrapper
 *      composition would silently break `/api/v1/dashboard/openapi.json`
 *      with `UnknownZodTypeError`; the round-trip test below catches
 *      that regression at unit-test speed.
 */
import { describe, expect, it } from 'bun:test'

import {
  coercedIntegerQuery,
  coercedOptionalPositiveIntegerQuery,
} from '../../src/openapi/coerced-query.js'

// ─── Runtime parsing ────────────────────────────────────────────────

describe('coercedIntegerQuery — runtime parsing', () => {
  const limit = coercedIntegerQuery({ min: 1, max: 100, default: 50 })

  it('parses a valid integer string within range', () => {
    expect(limit.parse('25')).toBe(25)
  })

  it('falls back to default on malformed input ("abc")', () => {
    expect(limit.parse('abc')).toBe(50)
  })

  it('falls back to default on a value below min', () => {
    expect(limit.parse('-5')).toBe(50)
  })

  it('falls back to default on a value above max', () => {
    expect(limit.parse('999')).toBe(50)
  })

  it('applies the default when input is undefined', () => {
    expect(limit.parse(undefined)).toBe(50)
  })

  it('respects min=0 when no max is set', () => {
    const offset = coercedIntegerQuery({ min: 0, default: 0 })
    expect(offset.parse('0')).toBe(0)
    expect(offset.parse('17')).toBe(17)
    expect(offset.parse('-1')).toBe(0) // below min → default
    expect(offset.parse('abc')).toBe(0)
  })

  it('throws at construction when max < min (catches swapped bounds)', () => {
    expect(() => coercedIntegerQuery({ min: 100, max: 10, default: 50 })).toThrow(
      /max \(10\) must be >= min \(100\)/
    )
  })

  it('allows max === min', () => {
    expect(() => coercedIntegerQuery({ min: 5, max: 5, default: 5 })).not.toThrow()
  })
})

describe('coercedOptionalPositiveIntegerQuery — runtime parsing', () => {
  const filter = coercedOptionalPositiveIntegerQuery()

  it('parses a valid positive integer string', () => {
    expect(filter.parse('42')).toBe(42)
  })

  it('returns undefined when input is undefined', () => {
    expect(filter.parse(undefined)).toBeUndefined()
  })

  it('returns undefined on malformed input', () => {
    expect(filter.parse('abc')).toBeUndefined()
  })

  it('returns undefined on negative input (positive constraint)', () => {
    expect(filter.parse('-5')).toBeUndefined()
  })

  it('returns undefined on zero (positive constraint)', () => {
    expect(filter.parse('0')).toBeUndefined()
  })
})

// ─── Spec generation round-trip ─────────────────────────────────────

describe('coercedIntegerQuery — OpenAPI generation', () => {
  it('emits type:integer with minimum, maximum, and default on a route query parameter', () => {
    const app = new OpenAPIHono()
    const querySchema = z.object({
      limit: coercedIntegerQuery({ min: 1, max: 100, default: 50 }),
      offset: coercedIntegerQuery({ min: 0, default: 0 }),
    })
    const route = createRoute({
      method: 'get',
      path: '/things',
      request: { query: querySchema },
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    })
    app.openapi(route, (c) => c.json({ ok: true }, 200))

    // The whole point of these tests: this call would throw
    // `UnknownZodTypeError` if the `.openapi(...)` annotation stopped
    // propagating through the `.catch().default()` chain.
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
    }) as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{
              name: string
              in: string
              schema: { type?: string; minimum?: number; maximum?: number; default?: number }
            }>
          }
        >
      >
    }

    const params = doc.paths['/things']?.['get']?.parameters ?? []
    const limitParam = params.find((p) => p.name === 'limit')
    const offsetParam = params.find((p) => p.name === 'offset')

    expect(limitParam?.in).toBe('query')
    expect(limitParam?.schema.type).toBe('integer')
    expect(limitParam?.schema.minimum).toBe(1)
    expect(limitParam?.schema.maximum).toBe(100)
    expect(limitParam?.schema.default).toBe(50)

    expect(offsetParam?.in).toBe('query')
    expect(offsetParam?.schema.type).toBe('integer')
    expect(offsetParam?.schema.minimum).toBe(0)
    expect(offsetParam?.schema.default).toBe(0)
    // No max declared on the offset schema -> no maximum on the spec.
    expect(offsetParam?.schema.maximum).toBeUndefined()
  })

  it('emits type:integer with minimum:1 on an optional positive filter', () => {
    const app = new OpenAPIHono()
    const querySchema = z.object({
      campaignId: coercedOptionalPositiveIntegerQuery(),
    })
    const route = createRoute({
      method: 'get',
      path: '/things',
      request: { query: querySchema },
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    })
    app.openapi(route, (c) => c.json({ ok: true }, 200))

    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
    }) as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{
              name: string
              in: string
              required?: boolean
              schema: { type?: string; minimum?: number }
            }>
          }
        >
      >
    }

    const params = doc.paths['/things']?.['get']?.parameters ?? []
    const campaignIdParam = params.find((p) => p.name === 'campaignId')

    expect(campaignIdParam?.in).toBe('query')
    expect(campaignIdParam?.schema.type).toBe('integer')
    expect(campaignIdParam?.schema.minimum).toBe(1)
    // .optional() at the Zod level should make the parameter non-required
    // in the emitted spec — pin that so future helper changes can't
    // silently promote an optional filter to a mandatory one.
    expect(campaignIdParam?.required ?? false).toBe(false)
  })
})
