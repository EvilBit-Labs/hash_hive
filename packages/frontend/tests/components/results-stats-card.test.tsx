import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { ResultsStatsCard } from '../../src/components/features/results/results-stats-card'
import { cleanupAll, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('ResultsStatsCard', () => {
  it('renders cracked count + total + crack rate with one-decimal precision when totalHashes is provided', () => {
    render(<ResultsStatsCard totalCracked={1283} totalHashes={5000} />)

    expect(screen.getByText('Cracked: 1,283 / 5,000 (25.7%)')).toBeDefined()
  })

  it('renders only cracked count when totalHashes is undefined (no rate, no slash)', () => {
    render(<ResultsStatsCard totalCracked={1283} />)

    expect(screen.getByText('Cracked: 1,283')).toBeDefined()
  })

  it('renders 0 / 0 without dividing by zero or producing NaN%', () => {
    render(<ResultsStatsCard totalCracked={0} totalHashes={0} />)

    // The empty-hash-list edge case must not surface NaN, Infinity, or %
    // arithmetic artifacts. Anchoring on the exact label ensures the
    // guard in `computeCrackRate` keeps holding.
    expect(screen.getByText('Cracked: 0 / 0 (0.0%)')).toBeDefined()
  })

  it('renders 0 cracked against a non-zero total as 0.0%', () => {
    render(<ResultsStatsCard totalCracked={0} totalHashes={5000} />)

    expect(screen.getByText('Cracked: 0 / 5,000 (0.0%)')).toBeDefined()
  })

  it('renders a subtitle when provided', () => {
    render(
      <ResultsStatsCard totalCracked={100} totalHashes={1000} subtitle="Scoped to this campaign" />
    )

    expect(screen.getByText('Scoped to this campaign')).toBeDefined()
  })
})
