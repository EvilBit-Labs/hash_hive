import { afterEach, describe, expect, it } from 'bun:test'

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

afterEach(() => {
  cleanupAll()
})

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

  it('uses text-3xl for the value when prominent is true (R13)', () => {
    renderWithProviders(<StatCard title="Cracked" value={42} subtitle="Total" prominent />)
    const valueEl = screen.getByText('42')
    expect(valueEl.className).toContain('text-3xl')
    expect(valueEl.className).not.toContain('text-2xl')
  })

  it('uses text-2xl for the value when prominent is false / default', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />)
    const valueEl = screen.getByText('7')
    expect(valueEl.className).toContain('text-2xl')
  })

  it('does not render a sparkline when sparkData has fewer than 2 points', () => {
    renderWithProviders(
      <StatCard
        title="Agents"
        value={7}
        subtitle="3 online"
        sparkData={[{ sampledAt: 1, value: 7 }]}
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
          { sampledAt: 1, value: 5 },
          { sampledAt: 2, value: 7 },
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
          { sampledAt: 1, value: 5 },
          { sampledAt: 2, value: 7 },
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
            { sampledAt: 1, value: 5 },
            { sampledAt: 2, value: 7 },
          ]}
          accent="--ctp-teal"
        />
        <StatCard
          title="Tasks"
          value={3}
          subtitle="running"
          sparkData={[
            { sampledAt: 1, value: 1 },
            { sampledAt: 2, value: 3 },
          ]}
          accent="--ctp-lavender"
        />
      </div>
    )
    expect(screen.getAllByTestId('stat-card')).toHaveLength(2)
    expect(screen.getAllByTestId('recharts-responsive-container').length).toBeGreaterThanOrEqual(2)
  })
})
