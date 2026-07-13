/**
 * Unit tests for the Agent API zaps opaque pagination cursor codec
 * (U1 of docs/plans/2026-07-12-001-feat-zaps-composite-cursor-plan.md).
 *
 * The codec is pure and side-effect-free, so these tests fully pin its
 * contract: lossless millisecond round-trip, base64url wire form, and
 * defensive decode (never trust the agent-controlled token).
 */
import { describe, expect, it } from 'bun:test'

import {
  decodeZapCursor,
  encodeZapCursor,
  ZapCursorError,
  type ZapCursor,
} from '../../src/services/tasks/zap-cursor.js'

describe('zap-cursor codec', () => {
  it('round-trips a cursor losslessly at millisecond precision', () => {
    // Arrange
    const cursor: ZapCursor = { crackedAt: new Date(1_752_000_000_123), id: 42 }

    // Act
    const decoded = decodeZapCursor(encodeZapCursor(cursor))

    // Assert
    expect(decoded.id).toBe(42)
    expect(decoded.crackedAt.getTime()).toBe(cursor.crackedAt.getTime())
  })

  it('produces a URL-safe base64url token with no +, /, or = characters', () => {
    // Arrange
    const cursor: ZapCursor = { crackedAt: new Date(1_752_000_000_999), id: 2_147_483_647 }

    // Act
    const token = encodeZapCursor(cursor)

    // Assert
    expect(token).not.toMatch(/[+/=]/)
  })

  it('rejects a token that is not valid base64url / decodable JSON', () => {
    // "!!!" is not valid base64url; even if permissively decoded it is not JSON.
    expect(() => decodeZapCursor('!!!not-base64!!!')).toThrow(ZapCursorError)
  })

  it('rejects valid base64url that does not decode to JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url')
    expect(() => decodeZapCursor(notJson)).toThrow(ZapCursorError)
  })

  it('rejects JSON of the wrong shape (missing c)', () => {
    const badShape = Buffer.from(JSON.stringify({ i: 1 }), 'utf8').toString('base64url')
    expect(() => decodeZapCursor(badShape)).toThrow(ZapCursorError)
  })

  it('rejects JSON of the wrong shape (missing i)', () => {
    const badShape = Buffer.from(JSON.stringify({ c: 1_752_000_000_000 }), 'utf8').toString(
      'base64url'
    )
    expect(() => decodeZapCursor(badShape)).toThrow(ZapCursorError)
  })

  it('rejects extra unexpected keys (strict shape)', () => {
    const extra = Buffer.from(
      JSON.stringify({ c: 1_752_000_000_000, i: 1, evil: true }),
      'utf8'
    ).toString('base64url')
    expect(() => decodeZapCursor(extra)).toThrow(ZapCursorError)
  })

  it('rejects a non-integer id', () => {
    const bad = Buffer.from(JSON.stringify({ c: 1_752_000_000_000, i: 1.5 }), 'utf8').toString(
      'base64url'
    )
    expect(() => decodeZapCursor(bad)).toThrow(ZapCursorError)
  })

  it('rejects id = 0, negative id, and id beyond int4', () => {
    for (const i of [0, -1, 2_147_483_648]) {
      const bad = Buffer.from(JSON.stringify({ c: 1_752_000_000_000, i }), 'utf8').toString(
        'base64url'
      )
      expect(() => decodeZapCursor(bad)).toThrow(ZapCursorError)
    }
  })

  it('rejects a negative or non-finite crackedAt (c)', () => {
    for (const c of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = Buffer.from(JSON.stringify({ c, i: 1 }), 'utf8').toString('base64url')
      expect(() => decodeZapCursor(bad)).toThrow(ZapCursorError)
    }
  })

  it('rejects c beyond the JS Date range (guards the 500-not-400 gap)', () => {
    // A structurally valid but out-of-Date-range c must fail decode rather
    // than becoming an Invalid Date that only surfaces as a 500 downstream.
    const bad = Buffer.from(JSON.stringify({ c: 8_640_000_000_000_001, i: 1 }), 'utf8').toString(
      'base64url'
    )
    expect(() => decodeZapCursor(bad)).toThrow(ZapCursorError)
  })
})
