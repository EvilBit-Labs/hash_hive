/**
 * Unit tests for `computeCampaignEtaState` (campaign-eta-rollup.ts) — the
 * pure precedence ladder underlying the issue #100 campaign ETA rollup. No
 * DB needed: `AttackEtaInput` is exported precisely so this combination
 * space can be driven directly.
 *
 * Code review fixes covered here:
 *   - Precision: the campaign-wide sum must go through the bigint
 *     `sumResolved`/`toBigInt` path (attacks/_internals.js `jsonSafeBigint`),
 *     never a `Number(...)` addition, or a sum past
 *     `Number.MAX_SAFE_INTEGER` silently loses precision.
 *   - Ordering: the `complete` check (zero non-terminal attacks) must run
 *     BEFORE the `paused` check, or a paused campaign with no non-terminal
 *     attacks left would misrender as "Paused" instead of "Complete".
 */
import { describe, expect, it } from 'bun:test'

import {
  type AttackEtaInput,
  computeCampaignEtaState,
} from '../../../src/services/campaign-eta-rollup'

describe('computeCampaignEtaState', () => {
  it('sums resolved ETAs past Number.MAX_SAFE_INTEGER as an exact decimal string', () => {
    // 9007199254740991 (Number.MAX_SAFE_INTEGER) + 10 = 9007199254741001,
    // which a float64 `Number(...) + Number(...)` addition cannot represent
    // exactly (it rounds to the nearest representable double past 2^53). The
    // bigint sum path must return the exact value instead.
    const attacks: AttackEtaInput[] = [
      { status: 'running', estimatedSecondsRemaining: '9007199254740991' },
      { status: 'running', estimatedSecondsRemaining: '10' },
    ]

    const eta = computeCampaignEtaState({
      campaignStatus: 'running',
      hasActiveAgents: true,
      attacks,
    })

    expect(eta).toEqual({ state: 'ready', seconds: '9007199254741001' })
  })

  it('reports complete for a paused campaign with zero non-terminal attacks', () => {
    // `complete` (zero non-terminal attacks) must be checked before
    // `paused` — otherwise this scenario would render "Paused" for a
    // campaign that has nothing left to estimate.
    const attacks: AttackEtaInput[] = [{ status: 'exhausted', estimatedSecondsRemaining: null }]

    const eta = computeCampaignEtaState({
      campaignStatus: 'paused',
      hasActiveAgents: false,
      attacks,
    })

    expect(eta).toEqual({ state: 'complete' })
  })
})
