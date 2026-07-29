import type { HashListTypeAnalysis } from '@hashhive/shared'

import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { HashTypeWarning } from '../../src/components/features/hash-type-warning'
import { cleanupAll, renderWithProviders } from '../test-utils'

afterEach(cleanupAll)

function buildAnalysis(over: Partial<HashListTypeAnalysis>): HashListTypeAnalysis {
  return {
    verdict: 'homogeneous',
    detectedModes: [{ hashcatMode: 0, count: 100 }],
    unidentifiedCount: 0,
    scannedCount: 100,
    sampled: false,
    declaredMode: null,
    analyzedAt: '2026-07-15T00:00:00.000Z',
    ...over,
  }
}

describe('HashTypeWarning', () => {
  it('renders nothing when typeAnalysis is null', () => {
    const { container } = renderWithProviders(<HashTypeWarning typeAnalysis={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a homogeneous list with zero unidentified entries', () => {
    const { container } = renderWithProviders(
      <HashTypeWarning
        typeAnalysis={buildAnalysis({ verdict: 'homogeneous', unidentifiedCount: 0 })}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows a mode breakdown for a mixed verdict', () => {
    renderWithProviders(
      <HashTypeWarning
        typeAnalysis={buildAnalysis({
          verdict: 'mixed',
          detectedModes: [
            { hashcatMode: 0, count: 60 },
            { hashcatMode: 1000, count: 40 },
          ],
          scannedCount: 100,
        })}
      />
    )
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText(/more than one hash type/)).toBeDefined()
    expect(screen.getByText(/2 hash types detected/)).toBeDefined()
    expect(screen.getByText(/mode 0 \(60, 60%\)/)).toBeDefined()
    expect(screen.getByText(/mode 1000 \(40, 40%\)/)).toBeDefined()
  })

  it('notes the unidentified count for a homogeneous list with unidentified entries', () => {
    renderWithProviders(
      <HashTypeWarning
        typeAnalysis={buildAnalysis({
          verdict: 'homogeneous',
          detectedModes: [{ hashcatMode: 0, count: 90 }],
          unidentifiedCount: 10,
          scannedCount: 100,
        })}
      />
    )
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText(/10 of 100 scanned entries/)).toBeDefined()
  })

  it('notes when the analysis was based on a sample', () => {
    renderWithProviders(
      <HashTypeWarning
        typeAnalysis={buildAnalysis({
          verdict: 'needs-review',
          unidentifiedCount: 500,
          scannedCount: 5000,
          sampled: true,
        })}
      />
    )
    expect(screen.getByText(/Based on a sample of the first 5,000 entries/)).toBeDefined()
  })
})
