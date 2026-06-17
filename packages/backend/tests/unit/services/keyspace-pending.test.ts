import { describe, expect, it } from 'bun:test'

import {
  isKeyspacePending,
  isResourceMetricSettling,
} from '../../../src/services/attacks/keyspace-pending'

// Base input with no resources referenced and a null keyspace. Spread + override
// per scenario so each test reads as a single varied dimension.
const base = {
  mode: 0,
  keyspace: null,
  wordlistStatus: null,
  rulelistStatus: null,
  masklistStatus: null,
} as const

describe('isResourceMetricSettling', () => {
  it('is true while the metric is still in flight', () => {
    expect(isResourceMetricSettling('pending')).toBe(true)
    expect(isResourceMetricSettling('uploading')).toBe(true)
    expect(isResourceMetricSettling('uploaded')).toBe(true)
    expect(isResourceMetricSettling('processing')).toBe(true)
  })

  it('is false once the metric has settled (ready) or failed (error)', () => {
    expect(isResourceMetricSettling('ready')).toBe(false)
    expect(isResourceMetricSettling('error')).toBe(false)
  })

  it('is false when no resource is referenced', () => {
    expect(isResourceMetricSettling(null)).toBe(false)
  })
})

describe('isKeyspacePending', () => {
  it('is never pending when the keyspace is already computed, for every mode', () => {
    for (const mode of [0, 1, 3, 6, 7, 2, 9]) {
      expect(
        isKeyspacePending({
          ...base,
          mode,
          keyspace: '1000',
          wordlistStatus: 'processing',
          masklistStatus: 'processing',
        })
      ).toBe(false)
    }
  })

  describe('mode 0 (straight)', () => {
    it('is pending while the wordlist is still settling', () => {
      expect(isKeyspacePending({ ...base, mode: 0, wordlistStatus: 'processing' })).toBe(true)
    })

    it('is pending when the wordlist is ready but the rulelist is still settling', () => {
      expect(
        isKeyspacePending({
          ...base,
          mode: 0,
          wordlistStatus: 'ready',
          rulelistStatus: 'processing',
        })
      ).toBe(true)
    })

    it('is not pending once all consumed resources have settled', () => {
      expect(
        isKeyspacePending({ ...base, mode: 0, wordlistStatus: 'ready', rulelistStatus: 'ready' })
      ).toBe(false)
    })
  })

  describe('mode 3 (mask)', () => {
    it('is pending while the masklist is still settling', () => {
      expect(isKeyspacePending({ ...base, mode: 3, masklistStatus: 'processing' })).toBe(true)
    })

    it('is not pending when the masklist has settled to a null keyspace (custom-charset .hcmask)', () => {
      // The core #230 bug: masklistId set, keyspace null, but the metric is
      // settled (ready) and concluded uncomputable -> "--", not "Computing...".
      expect(isKeyspacePending({ ...base, mode: 3, masklistStatus: 'ready' })).toBe(false)
    })

    it('is not pending for an inline mask with no masklist referenced', () => {
      // Inline mask keyspace is computed synchronously; a null result is settled.
      expect(isKeyspacePending({ ...base, mode: 3 })).toBe(false)
    })

    it('ignores a stray wordlist (mode-blind #230 repro)', () => {
      // A mask attack carrying an irrelevant, still-settling wordlist must not
      // show "Computing..." - mode 3 does not consume a wordlist.
      expect(isKeyspacePending({ ...base, mode: 3, wordlistStatus: 'processing' })).toBe(false)
    })
  })

  describe('modes 6 and 7 (hybrid)', () => {
    it('is pending while the wordlist is settling', () => {
      expect(isKeyspacePending({ ...base, mode: 6, wordlistStatus: 'uploading' })).toBe(true)
      expect(isKeyspacePending({ ...base, mode: 7, wordlistStatus: 'uploading' })).toBe(true)
    })

    it('is not pending once the wordlist has settled', () => {
      expect(isKeyspacePending({ ...base, mode: 6, wordlistStatus: 'ready' })).toBe(false)
      expect(isKeyspacePending({ ...base, mode: 7, wordlistStatus: 'ready' })).toBe(false)
    })
  })

  describe('mode 1 (combination)', () => {
    it('is pending while the wordlist is settling', () => {
      expect(isKeyspacePending({ ...base, mode: 1, wordlistStatus: 'processing' })).toBe(true)
    })
  })

  it('is never pending for a failed resource (error status)', () => {
    expect(isKeyspacePending({ ...base, mode: 0, wordlistStatus: 'error' })).toBe(false)
    expect(isKeyspacePending({ ...base, mode: 3, masklistStatus: 'error' })).toBe(false)
  })

  it('is not pending for PRINCE / generator / unknown modes regardless of resources', () => {
    expect(
      isKeyspacePending({
        ...base,
        mode: 2,
        wordlistStatus: 'processing',
        masklistStatus: 'processing',
      })
    ).toBe(false)
    expect(isKeyspacePending({ ...base, mode: 9, wordlistStatus: 'processing' })).toBe(false)
  })
})
