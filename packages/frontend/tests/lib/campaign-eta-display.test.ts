import type { CampaignEta } from '@hashhive/shared'

import { describe, expect, it } from 'bun:test'

import { formatCampaignEta } from '../../src/lib/campaign-eta-display'

describe('formatCampaignEta', () => {
  it('renders the ready state as a plain duration', () => {
    const eta: CampaignEta = { state: 'ready', seconds: 12000 }
    expect(formatCampaignEta(eta)).toBe('3h 20m')
  })

  it('renders the ready state at 0 seconds as 0s, never blank', () => {
    const eta: CampaignEta = { state: 'ready', seconds: 0 }
    expect(formatCampaignEta(eta)).toBe('0s')
  })

  it('accepts the bigint-safe string seconds form', () => {
    const eta: CampaignEta = { state: 'ready', seconds: '99999999999' }
    expect(formatCampaignEta(eta)).toBe('> 1 year')
  })

  it('renders lower_bound with a ">=" prefix and singular attack noun for one pending attack (AE4)', () => {
    const eta: CampaignEta = { state: 'lower_bound', seconds: 14400, pendingAttacks: 1 }
    expect(formatCampaignEta(eta)).toBe('>= 4h (1 attack still estimating)')
  })

  it('pluralizes the attack noun for more than one pending attack', () => {
    const eta: CampaignEta = { state: 'lower_bound', seconds: 14400, pendingAttacks: 3 }
    expect(formatCampaignEta(eta)).toBe('>= 4h (3 attacks still estimating)')
  })

  it('renders the estimating state as a reason, not a number (AE2)', () => {
    const eta: CampaignEta = { state: 'estimating' }
    expect(formatCampaignEta(eta)).toBe('Estimating...')
  })

  it('renders the paused state as a reason, not a stale number (AE3)', () => {
    const eta: CampaignEta = { state: 'paused' }
    expect(formatCampaignEta(eta)).toBe('Paused')
  })

  it('renders the no_agents state as a reason', () => {
    const eta: CampaignEta = { state: 'no_agents' }
    expect(formatCampaignEta(eta)).toBe('No agents assigned')
  })

  it('renders the complete state without a fabricated "0h" duration (AE7)', () => {
    const eta: CampaignEta = { state: 'complete' }
    expect(formatCampaignEta(eta)).toBe('Complete')
  })
})
