/**
 * Pure unit tests for agent-config service helpers.
 * No DB, no mock.module() — only functions that take data and return data.
 *
 * Covered:
 *  - validateRawFlags: length, token count, denylist prefix matching
 *  - mergeEffectiveConfig: per-knob merge, hardware isolation, empty cases
 *  - mergeWhitelist: union dedup
 */

import { RAW_FLAG_DENYLIST, RAW_FLAGS_MAX_LEN, RAW_FLAGS_MAX_TOKENS } from '@hashhive/shared'
import { describe, expect, it } from 'bun:test'

import {
  mergeEffectiveConfig,
  mergeWhitelist,
  validateRawFlags,
} from '../../../src/services/agent-config.js'

// ─── validateRawFlags ─────────────────────────────────────────────────────────

describe('validateRawFlags', () => {
  it('returns ok:true for undefined', () => {
    expect(validateRawFlags(undefined)).toEqual({ ok: true })
  })

  it('returns ok:true for an empty string', () => {
    expect(validateRawFlags('')).toEqual({ ok: true })
  })

  it('returns ok:true for a whitespace-only string', () => {
    expect(validateRawFlags('   ')).toEqual({ ok: true })
  })

  it('returns ok:true for a valid flag string', () => {
    expect(validateRawFlags('--force --status --status-timer=5')).toEqual({ ok: true })
  })

  it('returns ok:false when length exceeds RAW_FLAGS_MAX_LEN', () => {
    const raw = '-O '.repeat(200).slice(0, RAW_FLAGS_MAX_LEN + 1)
    const result = validateRawFlags(raw)
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_TOO_LONG' })
  })

  it('returns ok:false when token count exceeds RAW_FLAGS_MAX_TOKENS', () => {
    // Build a valid string with too many tokens (each is 2 chars + space).
    const tokens = Array.from({ length: RAW_FLAGS_MAX_TOKENS + 1 }, (_, i) => `-x${i}`)
    const raw = tokens.join(' ')
    // Ensure length is under the cap so we're only testing token count.
    expect(raw.length).toBeLessThan(RAW_FLAGS_MAX_LEN)
    const result = validateRawFlags(raw)
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_TOO_MANY_TOKENS' })
  })

  it('returns ok:false for an exact denylist entry', () => {
    const result = validateRawFlags('--potfile-disable')
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_DENIED' })
  })

  it('returns ok:false for a denylist entry with =value form', () => {
    const result = validateRawFlags('--outfile=/tmp/crack.txt')
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_DENIED' })
  })

  it('returns ok:false for --session (denylist entry)', () => {
    const result = validateRawFlags('--force --session=mysession')
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_DENIED' })
  })

  it('returns ok:true for a flag that starts with a denylist prefix but is not in it', () => {
    // --outfile-foo is NOT in the denylist; only --outfile is.
    // Verify we exact-match, not prefix-match beyond the list entries.
    const result = validateRawFlags('--outfile-foo')
    // '--outfile-foo' is different from '--outfile' so should be ok.
    // '--outfile' IS in the denylist; '--outfile-foo' is NOT (no startsWith used here).
    expect(result).toEqual({ ok: true })
  })

  it('covers all denylist entries', () => {
    for (const entry of RAW_FLAG_DENYLIST) {
      const result = validateRawFlags(entry)
      expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_DENIED' })
    }
  })

  it('rejects the short -o flag with a space-separated value', () => {
    const result = validateRawFlags('-o /etc/passwd')
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_DENIED' })
  })

  it('rejects the short -o flag with an attached value (bypass attempt)', () => {
    const result = validateRawFlags('-o/etc/passwd')
    expect(result).toMatchObject({ ok: false, code: 'RAW_FLAGS_DENIED' })
  })

  it('does not reject -O (optimized kernel, distinct from -o)', () => {
    // -O is uppercase and is NOT a denied flag; short-flag matching is
    // case-sensitive so it must not be caught by the -o prefix rule.
    expect(validateRawFlags('-O')).toEqual({ ok: true })
  })

  it('rejects hashcat brain network flags (egress / credential exfil)', () => {
    // The "brain" feature would let a config edit turn the worker into a
    // network client/server reaching an operator-supplied host.
    expect(validateRawFlags('--brain-client')).toMatchObject({
      ok: false,
      code: 'RAW_FLAGS_DENIED',
    })
    expect(validateRawFlags('--brain-server')).toMatchObject({
      ok: false,
      code: 'RAW_FLAGS_DENIED',
    })
    expect(validateRawFlags('--brain-host=10.0.0.1')).toMatchObject({
      ok: false,
      code: 'RAW_FLAGS_DENIED',
    })
    expect(validateRawFlags('--brain-password=hunter2')).toMatchObject({
      ok: false,
      code: 'RAW_FLAGS_DENIED',
    })
  })

  it('rejects --loopback (writes cracked plains via the session/induction dir)', () => {
    expect(validateRawFlags('--loopback')).toMatchObject({
      ok: false,
      code: 'RAW_FLAGS_DENIED',
    })
  })
})

// ─── mergeEffectiveConfig ─────────────────────────────────────────────────────

describe('mergeEffectiveConfig', () => {
  it('returns fleet tuning when rig has no override', () => {
    const result = mergeEffectiveConfig({}, { tuning: { hashcat: { workloadProfile: 2 } } })
    expect(result.tuning.hashcat?.workloadProfile).toBe(2)
  })

  it('returns per-rig override when rig specifies a tuning knob', () => {
    const result = mergeEffectiveConfig(
      { tuning: { hashcat: { workloadProfile: 4 } } },
      { tuning: { hashcat: { workloadProfile: 2 } } }
    )
    expect(result.tuning.hashcat?.workloadProfile).toBe(4)
  })

  it('merges at the knob level — unset rig knob inherits from fleet', () => {
    const result = mergeEffectiveConfig(
      { tuning: { hashcat: { kernelAccel: 8 } } },
      { tuning: { hashcat: { workloadProfile: 3, kernelLoops: 4 } } }
    )
    // rig knob wins
    expect(result.tuning.hashcat?.kernelAccel).toBe(8)
    // fleet knobs that rig didn't set are inherited
    expect(result.tuning.hashcat?.workloadProfile).toBe(3)
    expect(result.tuning.hashcat?.kernelLoops).toBe(4)
  })

  it('hardware is always per-rig only — never from fleet', () => {
    // Fleet config schema doesn't include hardware, but mergeEffectiveConfig
    // should only read hardware from perRig.
    // Note: deviceIds uses .positive() which means > 0, so use 1-based ids.
    const result = mergeEffectiveConfig(
      { hardware: { deviceIds: [1, 2], tempAbort: 90 } },
      { tuning: { hashcat: { workloadProfile: 2 } } }
    )
    expect(result.hardware.deviceIds).toEqual([1, 2])
    expect(result.hardware.tempAbort).toBe(90)
  })

  it('hardware is empty when rig has none', () => {
    const result = mergeEffectiveConfig({}, {})
    // effectiveAgentConfigSchema requires both tuning and hardware — both are present
    expect(result.hardware).toEqual({})
  })

  it('returns empty tuning when neither rig nor fleet has any', () => {
    const result = mergeEffectiveConfig({}, {})
    expect(result.tuning).toEqual({})
  })

  it('both keys always present — schema requires tuning and hardware', () => {
    const result = mergeEffectiveConfig({}, {})
    expect('tuning' in result).toBe(true)
    expect('hardware' in result).toBe(true)
  })
})

// ─── mergeWhitelist ───────────────────────────────────────────────────────────

describe('mergeWhitelist', () => {
  it('returns empty array when both are empty', () => {
    expect(mergeWhitelist({}, {})).toEqual([])
  })

  it('returns fleet-only entries when rig has none', () => {
    expect(mergeWhitelist({}, { errorWhitelist: ['pattern-a'] })).toEqual(['pattern-a'])
  })

  it('returns rig-only entries when fleet has none', () => {
    expect(mergeWhitelist({ errorWhitelist: ['pattern-b'] }, {})).toEqual(['pattern-b'])
  })

  it('unions fleet and rig entries', () => {
    const result = mergeWhitelist(
      { errorWhitelist: ['rig-pattern'] },
      { errorWhitelist: ['fleet-pattern'] }
    )
    expect(result).toContain('fleet-pattern')
    expect(result).toContain('rig-pattern')
    expect(result).toHaveLength(2)
  })

  it('deduplicates entries that appear in both', () => {
    const result = mergeWhitelist(
      { errorWhitelist: ['shared', 'rig-only'] },
      { errorWhitelist: ['shared', 'fleet-only'] }
    )
    expect(result.filter((e) => e === 'shared')).toHaveLength(1)
    expect(result).toContain('rig-only')
    expect(result).toContain('fleet-only')
    expect(result).toHaveLength(3)
  })
})
