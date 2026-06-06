import { afterEach, describe, expect, it } from 'bun:test'

import type { MonotonicMs } from '../../src/hooks/use-spark-history'

import { StatCard } from '../../src/components/features/stat-card'
import {
  cleanupAll,
  fireEvent,
  renderWithMotion,
  renderWithProviders,
  renderWithRouter,
  screen,
  waitFor,
} from '../test-utils'

// cleanupAll() already invokes Testing Library's cleanup() plus
// resetAllStores(); calling cleanup() explicitly was redundant.
afterEach(cleanupAll)

describe('StatCard', () => {
  it('renders title, value, and subtitle', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    expect(screen.getByText('Agents')).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()
    expect(screen.getByText('3 online')).toBeDefined()
  })

  it('renders a Skeleton placeholder when loading and no literal hyphen', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" loading />)
    expect(screen.queryByText('-')).toBeNull()
    expect(screen.queryByText('7')).toBeNull()
    // Skeleton primitive renders with aria-hidden + animate-pulse default class
    const card = screen.getByTestId('stat-card')
    const skeletons = card.querySelectorAll('[aria-hidden="true"]')
    expect(skeletons.length).toBeGreaterThanOrEqual(1)
  })

  it('renders string values without count-up logic', () => {
    renderWithMotion(<StatCard title="Status" value="Active" subtitle="All systems go" />)
    expect(screen.getByText('Active')).toBeDefined()
  })

  it('renders as a div when no "to" prop is provided', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders as a button when "to" prop is provided', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" to="/agents" />)
    const button = screen.getByRole('button')
    expect(button).toBeDefined()
    expect(button.tagName).toBe('BUTTON')
  })

  it('navigates to the target route when clicked', () => {
    renderWithRouter(
      [
        {
          path: '/',
          element: <StatCard title="Agents" value={7} subtitle="3 online" to="/agents" />,
        },
        { path: '/agents', element: <div>Agents Page</div> },
      ],
      { initialRoute: '/' }
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Agents Page')).toBeDefined()
  })

  it('carries data-testid="stat-card" on the rendered root for e2e selectors', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    expect(screen.getByTestId('stat-card')).toBeDefined()
  })

  it('exposes an aria-live region around the numeric value slot', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    const card = screen.getByTestId('stat-card')
    const liveRegion = card.querySelector('[aria-live="polite"][aria-atomic="true"]')
    expect(liveRegion).not.toBeNull()
  })

  it('uses the hero text scale (text-5xl) for the value when emphasis is primary', () => {
    renderWithProviders(<StatCard title="Cracked" value={42} subtitle="Total" emphasis="primary" />)
    const valueEl = screen.getByText('42')
    expect(valueEl.className).toContain('text-5xl')
    expect(valueEl.className).not.toContain('text-2xl')
  })

  it('uses the supporting text scale (text-2xl) for the value when emphasis is secondary / default', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    const valueEl = screen.getByText('7')
    expect(valueEl.className).toContain('text-2xl')
    expect(valueEl.className).not.toContain('text-5xl')
  })

  it('drops the side-stripe accent border (full border only, no border-l-2)', () => {
    renderWithProviders(
      <StatCard title="Agents" value={7} subtitle="3 online" accent="--ctp-teal" />
    )
    const card = screen.getByTestId('stat-card')
    expect(card.className).not.toContain('border-l-2')
    // No inline border-left-color either — the side-stripe is the banned pattern
    expect(card.getAttribute('style') ?? '').not.toContain('border-left-color')
  })

  it('tints the secondary card title in the per-domain accent color', () => {
    renderWithProviders(
      <StatCard title="Agents" value={7} subtitle="3 online" accent="--ctp-teal" />
    )
    const title = screen.getByText('Agents')
    expect(title.getAttribute('style') ?? '').toContain('hsl(var(--ctp-teal))')
    expect(title.className).not.toContain('text-muted-foreground')
  })

  it('falls back to muted-foreground when no accent is set on a secondary card', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    const title = screen.getByText('Agents')
    expect(title.className).toContain('text-muted-foreground')
    expect(title.getAttribute('style') ?? '').not.toContain('hsl(var(')
  })

  it('does not render a sparkline when sparkData has fewer than 2 points', () => {
    renderWithProviders(
      <StatCard
        title="Agents"
        value={7}
        subtitle="3 online"
        sparkData={[{ sampledAtMs: 1 as MonotonicMs, value: 7 }]}
        accent="--ctp-teal"
      />
    )
    expect(screen.queryByTestId('recharts-responsive-container')).toBeNull()
  })

  it('renders a sparkline when sparkData has 2 or more points', () => {
    renderWithProviders(
      <StatCard
        title="Agents"
        value={7}
        subtitle="3 online"
        sparkData={[
          { sampledAtMs: 1 as MonotonicMs, value: 5 },
          { sampledAtMs: 2 as MonotonicMs, value: 7 },
        ]}
        accent="--ctp-teal"
      />
    )
    expect(screen.getByTestId('recharts-responsive-container')).toBeDefined()
  })

  it('labels the sparkline region for assistive tech (R16)', () => {
    renderWithProviders(
      <StatCard
        title="Agents"
        value={7}
        subtitle="3 online"
        sparkData={[
          { sampledAtMs: 1 as MonotonicMs, value: 5 },
          { sampledAtMs: 2 as MonotonicMs, value: 7 },
        ]}
        accent="--ctp-teal"
      />
    )
    const sparkRegion = screen.getByLabelText(/Agents trend/i)
    expect(sparkRegion).toBeDefined()
  })

  it('mounts a fresh value span on rerender when the numeric value changes', async () => {
    // Cross-fade is keyed by `String(value)`; rerendering with a new value
    // unmounts the old motion.span and mounts a new one. Happy-dom does not
    // reliably fire Motion's exit-complete callback so the outgoing span can
    // briefly linger — assert the new value appears, which is the
    // user-observable signal the cross-fade fired.
    const { rerender } = renderWithMotion(<StatCard title="Cracked" value={5} subtitle="Total" />)
    expect(screen.getByText('5')).toBeDefined()

    rerender(<StatCard title="Cracked" value={42} subtitle="Total" />)
    await waitFor(() => expect(screen.getByText('42')).toBeDefined())
  })

  describe('celebrateOnIncrement (delight)', () => {
    it('renders a "+N" delta badge when a celebrated value increments', async () => {
      const { rerender } = renderWithMotion(
        <StatCard title="Cracked" value={5} subtitle="Total" celebrateOnIncrement />
      )
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()

      rerender(<StatCard title="Cracked" value={8} subtitle="Total" celebrateOnIncrement />)
      const badge = await screen.findByTestId('stat-card-delta-badge')
      expect(badge.textContent).toBe('+3')
    })

    it('does NOT celebrate when celebrateOnIncrement is unset (default)', async () => {
      const { rerender } = renderWithMotion(<StatCard title="Agents" value={3} subtitle="Online" />)
      rerender(<StatCard title="Agents" value={5} subtitle="Online" />)
      // Give the effect a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()
    })

    it('does NOT celebrate on a decrement (delight is for the up-direction only)', async () => {
      const { rerender } = renderWithMotion(
        <StatCard title="Cracked" value={5} subtitle="Total" celebrateOnIncrement />
      )
      rerender(<StatCard title="Cracked" value={3} subtitle="Total" celebrateOnIncrement />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()
    })

    it('does NOT celebrate on a large jump (project switch / bulk import)', async () => {
      const { rerender } = renderWithMotion(
        <StatCard title="Cracked" value={42} subtitle="Total" celebrateOnIncrement />
      )
      // Delta of 1234 is unambiguously not a single cracking moment.
      rerender(<StatCard title="Cracked" value={1276} subtitle="Total" celebrateOnIncrement />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()
    })

    it('celebrates at the ceiling (+20) but NOT one past it (+21)', async () => {
      // Pin the CELEBRATE_MAX_DELTA cliff so a future tweak to the
      // single-batch ceiling lands as an intentional test update,
      // not a silent UX shift.
      const { rerender } = renderWithMotion(
        <StatCard title="Cracked" value={0} subtitle="Total" celebrateOnIncrement />
      )
      rerender(<StatCard title="Cracked" value={20} subtitle="Total" celebrateOnIncrement />)
      const badge = await screen.findByTestId('stat-card-delta-badge')
      expect(badge.textContent).toBe('+20')

      cleanupAll()

      const { rerender: rerender2 } = renderWithMotion(
        <StatCard title="Cracked" value={0} subtitle="Total" celebrateOnIncrement />
      )
      rerender2(<StatCard title="Cracked" value={21} subtitle="Total" celebrateOnIncrement />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()
    })

    it('does NOT celebrate when transitioning through the "?" unknown sentinel', async () => {
      // Project-switch case: 42 -> '?' (refetch window) -> 100. The
      // intermediate '?' resets the previous-value ref, so the eventual
      // numeric value sees a non-number previous and short-circuits.
      const { rerender } = renderWithMotion(
        <StatCard title="Cracked" value={42} subtitle="Total" celebrateOnIncrement />
      )
      rerender(<StatCard title="Cracked" value={'?'} subtitle="Total" celebrateOnIncrement />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      rerender(<StatCard title="Cracked" value={100} subtitle="Total" celebrateOnIncrement />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()
    })

    it('does NOT celebrate on initial mount even with a numeric value', async () => {
      renderWithMotion(
        <StatCard title="Cracked" value={42} subtitle="Total" celebrateOnIncrement />
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByTestId('stat-card-delta-badge')).toBeNull()
    })
  })

  it('renders two cards side-by-side without crashing on shared sparkData (gradient id uniqueness)', () => {
    // Gradient id collision would surface as a recharts render error or as visual
    // bleed; happy-dom does not reliably expose SVG defs to querySelector, so the
    // DOM-level uniqueness assertion is enforced by Playwright e2e (U7). Here we
    // just verify both cards mount and expose their sparkline regions.
    renderWithProviders(
      <div>
        <StatCard
          title="Agents"
          value={7}
          subtitle="online"
          sparkData={[
            { sampledAtMs: 1 as MonotonicMs, value: 5 },
            { sampledAtMs: 2 as MonotonicMs, value: 7 },
          ]}
          accent="--ctp-teal"
        />
        <StatCard
          title="Tasks"
          value={3}
          subtitle="running"
          sparkData={[
            { sampledAtMs: 1 as MonotonicMs, value: 1 },
            { sampledAtMs: 2 as MonotonicMs, value: 3 },
          ]}
          accent="--ctp-lavender"
        />
      </div>
    )
    expect(screen.getAllByTestId('stat-card')).toHaveLength(2)
    expect(screen.getAllByTestId('recharts-responsive-container').length).toBeGreaterThanOrEqual(2)
  })
})
