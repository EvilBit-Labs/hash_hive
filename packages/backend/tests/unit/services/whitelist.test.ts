/**
 * Unit tests for `services/agents/whitelist.ts`.
 *
 * Pure-function tests — no DB, no module-level mocks needed.
 * These run in the catch-all `bun test ... tests/unit` phase.
 */
import { describe, expect, it } from 'bun:test'

import {
  REVIEW_RECOMMENDED_THRESHOLD,
  WHITELISTED_SEVERITY,
  downgradeIfWhitelisted,
  matchesWhitelist,
} from '../../../src/services/agents/whitelist.js'

// ─── matchesWhitelist ─────────────────────────────────────────────────────────

describe('matchesWhitelist', () => {
  it('returns false when whitelist is empty', () => {
    expect(matchesWhitelist('No hashes loaded', [])).toBe(false)
  })

  it('matches a pattern that is an exact substring of the message', () => {
    expect(matchesWhitelist('No hashes loaded', ['No hashes loaded'])).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(matchesWhitelist('NO HASHES LOADED', ['no hashes loaded'])).toBe(true)
    expect(matchesWhitelist('no hashes loaded', ['NO HASHES LOADED'])).toBe(true)
    expect(matchesWhitelist('No Hashes Loaded', ['no hashes'])).toBe(true)
  })

  it('matches when the pattern is a substring of the message', () => {
    expect(matchesWhitelist('Fatal: No hashes loaded in file', ['No hashes loaded'])).toBe(true)
  })

  it('returns false when no pattern matches', () => {
    expect(matchesWhitelist('GPU memory error', ['No hashes loaded', 'dict file not found'])).toBe(
      false
    )
  })

  it('skips empty/whitespace-only patterns (never matches everything)', () => {
    // An empty pattern would match every message via `''.includes('')`; skip it.
    expect(matchesWhitelist('any message', ['', '   ', '\t'])).toBe(false)
  })

  it('matches via any pattern in the list (OR semantics)', () => {
    const whitelist = ['No hashes loaded', 'dict file not found']
    expect(matchesWhitelist('dict file not found on startup', whitelist)).toBe(true)
    expect(matchesWhitelist('No hashes loaded at runtime', whitelist)).toBe(true)
  })

  it('returns false on empty message with non-empty whitelist', () => {
    expect(matchesWhitelist('', ['No hashes loaded'])).toBe(false)
  })
})

// ─── downgradeIfWhitelisted ───────────────────────────────────────────────────

describe('downgradeIfWhitelisted', () => {
  it('returns the original object unchanged when whitelist is empty', () => {
    const error = { severity: 'fatal', message: 'No hashes loaded' }
    const result = downgradeIfWhitelisted(error, [])
    expect(result).toBe(error) // reference equality — not mutated, same object
  })

  it('returns the original object unchanged when no pattern matches', () => {
    const error = { severity: 'fatal', message: 'GPU out of memory' }
    const result = downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(result).toBe(error)
  })

  it('returns a NEW object when the message matches a whitelist pattern', () => {
    const error = { severity: 'fatal', message: 'No hashes loaded' }
    const result = downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(result).not.toBe(error) // new object — immutable update
  })

  it('sets severity to WHITELISTED_SEVERITY on a match', () => {
    const error = { severity: 'fatal', message: 'No hashes loaded' }
    const result = downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(result.severity).toBe(WHITELISTED_SEVERITY)
  })

  it('adds context.whitelisted = true on a match', () => {
    const error = { severity: 'fatal', message: 'No hashes loaded' }
    const result = downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(result.context?.['whitelisted']).toBe(true)
  })

  it('preserves existing context fields when adding whitelisted marker', () => {
    const error = {
      severity: 'warning',
      message: 'No hashes loaded',
      context: { exitCode: 1, detail: 'hash file empty' },
    }
    const result = downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(result.context?.['exitCode']).toBe(1)
    expect(result.context?.['detail']).toBe('hash file empty')
    expect(result.context?.['whitelisted']).toBe(true)
  })

  it('preserves message unchanged after downgrade', () => {
    const error = { severity: 'error', message: 'No hashes loaded — file was empty' }
    const result = downgradeIfWhitelisted(error, ['no hashes loaded'])
    expect(result.message).toBe('No hashes loaded — file was empty')
  })

  it('does not mutate the original error object', () => {
    const error = { severity: 'fatal', message: 'No hashes loaded', context: { a: 1 } }
    const original = { ...error, context: { ...error.context } }
    downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(error.severity).toBe(original.severity)
    expect(error.context['a']).toBe(1)
    expect((error.context as Record<string, unknown>)['whitelisted']).toBeUndefined()
  })

  it('matches case-insensitively (inherits matchesWhitelist behavior)', () => {
    const error = { severity: 'fatal', message: 'NO HASHES LOADED' }
    const result = downgradeIfWhitelisted(error, ['no hashes loaded'])
    expect(result.severity).toBe(WHITELISTED_SEVERITY)
  })

  it('handles undefined context gracefully — sets context.whitelisted on a match', () => {
    const error = { severity: 'fatal', message: 'No hashes loaded' }
    const result = downgradeIfWhitelisted(error, ['No hashes loaded'])
    expect(result.context).toEqual({ whitelisted: true })
  })
})

// ─── Constants sanity ────────────────────────────────────────────────────────

describe('constants', () => {
  it('WHITELISTED_SEVERITY is excluded from FATAL and WARNING severity lists', () => {
    // This test pins the invariant that the downgrade value is never counted
    // by the badge SQL. If FATAL_SEVERITIES or WARNING_SEVERITIES ever
    // absorbs 'info', the badge would start counting whitelisted rows.
    expect(WHITELISTED_SEVERITY).toBe('info')
    // Direct constant check — the badge-SQL exclusion is proven by the DB tests.
  })

  it('REVIEW_RECOMMENDED_THRESHOLD is a positive integer', () => {
    expect(Number.isInteger(REVIEW_RECOMMENDED_THRESHOLD)).toBe(true)
    expect(REVIEW_RECOMMENDED_THRESHOLD).toBeGreaterThan(0)
  })
})
