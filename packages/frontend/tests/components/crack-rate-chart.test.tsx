import { afterEach, describe, expect, it } from 'bun:test'

import { CrackRateTrendChart } from '../../src/components/features/crack-rate-chart'
import { cleanupAll, render, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('CrackRateTrendChart', () => {
  it('renders the recharts container when given >= 2 data points', () => {
    render(
      <CrackRateTrendChart
        data={[
          { sampledAt: 1, value: 0 },
          { sampledAt: 2, value: 5 },
          { sampledAt: 3, value: 12 },
        ]}
      />
    )
    expect(screen.getByTestId('recharts-responsive-container')).toBeDefined()
  })

  it('renders a Skeleton when loading=true', () => {
    const { container } = render(<CrackRateTrendChart data={[]} loading />)
    expect(screen.queryByTestId('recharts-responsive-container')).toBeNull()
    expect(screen.queryByText(/No cracks yet/i)).toBeNull()
    // Skeleton primitive is aria-hidden + animate-pulse
    const sk = container.querySelector('[aria-hidden="true"]')
    expect(sk).not.toBeNull()
    expect(sk?.className).toContain('animate-pulse')
  })

  it('renders the cold-session empty state (R15) when not loading and data has < 2 points', () => {
    render(<CrackRateTrendChart data={[{ sampledAt: 1, value: 0 }]} />)
    expect(screen.getByText(/No cracks yet in this session/i)).toBeDefined()
    expect(screen.queryByTestId('recharts-responsive-container')).toBeNull()
    // Skeleton must NOT be present for the empty state — pulse implies loading
    const pulses = document.body.querySelectorAll('.animate-pulse')
    expect(pulses).toHaveLength(0)
  })

  it('cold-session empty state has role="status" so it is announced once', () => {
    render(<CrackRateTrendChart data={[]} />)
    const status = screen.getByRole('status')
    expect(status.textContent ?? '').toMatch(/No cracks yet/i)
  })

  it('section wrapper labels the chart for assistive tech (R16)', () => {
    render(
      <CrackRateTrendChart
        data={[
          { sampledAt: 1, value: 0 },
          { sampledAt: 2, value: 5 },
        ]}
      />
    )
    // Section role with accessible name "Crack rate trend"
    const section = screen.getByRole('region', { name: /crack rate trend/i })
    expect(section).toBeDefined()
  })
})
