import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'

import { Tabs } from '../../src/components/ui/tabs'
import { cleanupAll, fireEvent, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

interface HarnessProps {
  readonly initial?: string
  readonly onChange?: (next: string) => void
}

/**
 * Test harness that owns active value the same way the callsite does.
 * Keeps Tabs controlled and lets tests observe the `onChange` payload.
 *
 * NOTE: Radix Tabs triggers onValueChange on mouseDown (button=0, ctrlKey=false),
 * not onClick. Use fireEvent.mouseDown (not fireEvent.click) to drive tab changes
 * in happy-dom tests.
 */
function TabsHarness({ initial = 'attacks', onChange }: HarnessProps) {
  const [value, setValue] = useState(initial)
  return (
    <Tabs
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    >
      <Tabs.List aria-label="Sections">
        <Tabs.Trigger value="attacks">Attacks</Tabs.Trigger>
        <Tabs.Trigger value="results">Results</Tabs.Trigger>
        <Tabs.Trigger value="agents">Agents</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="attacks">attacks panel</Tabs.Content>
      <Tabs.Content value="results">results panel</Tabs.Content>
      <Tabs.Content value="agents">agents panel</Tabs.Content>
    </Tabs>
  )
}

/** Fire the event that Radix Tabs actually listens to (mouseDown, button=0). */
function activateTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
}

describe('Tabs', () => {
  describe('rendering', () => {
    it('renders only the active tab panel when value matches a trigger', () => {
      render(<TabsHarness initial="results" />)

      // Radix renders inactive panels with the hidden attribute; getByRole
      // excludes hidden elements, so only the active panel is discoverable.
      expect(screen.getByRole('tabpanel')).toBeDefined()
      expect(screen.getByRole('tabpanel').textContent).toBe('results panel')
    })

    it('renders no visible panel when value does not match any trigger', () => {
      render(<TabsHarness initial="nonexistent" />)

      // No panel has data-state=active so no tabpanel is reachable via role.
      expect(screen.queryByRole('tabpanel')).toBeNull()
    })
  })

  describe('accessibility', () => {
    it('exposes role=tablist with aria-label', () => {
      render(<TabsHarness initial="results" />)

      const tablist = screen.getByRole('tablist')
      expect(tablist.getAttribute('aria-label')).toBe('Sections')
    })

    it('renders all triggers as role=tab', () => {
      render(<TabsHarness initial="results" />)

      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(3)
    })

    it('marks the active tab aria-selected=true and inactive tabs aria-selected=false', () => {
      render(<TabsHarness initial="results" />)

      const activeTab = screen.getByRole('tab', { name: 'Results' })
      expect(activeTab.getAttribute('aria-selected')).toBe('true')

      const inactiveTab = screen.getByRole('tab', { name: 'Attacks' })
      expect(inactiveTab.getAttribute('aria-selected')).toBe('false')
    })
  })

  describe('interaction', () => {
    it('activating an inactive trigger fires onChange with that value', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      activateTab(screen.getByRole('tab', { name: 'Results' }))

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith('results')
    })

    it('activating a trigger switches the visible panel', () => {
      render(<TabsHarness initial="attacks" />)

      activateTab(screen.getByRole('tab', { name: 'Results' }))

      expect(screen.getByRole('tabpanel').textContent).toBe('results panel')
    })

    it('passing the legacy onChange prop fires on tab change — proves onChange→onValueChange alias', () => {
      // Critical regression guard: if onChange is not aliased to Radix's
      // onValueChange, this handler silently no-ops and the assertion fails.
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      activateTab(screen.getByRole('tab', { name: 'Agents' }))

      expect(onChange).toHaveBeenCalledWith('agents')
    })

    it('activating the already-active tab does not fire onChange', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      // Radix does not emit onValueChange when the controlled value would not
      // change (active tab mouseDown with same value).
      activateTab(screen.getByRole('tab', { name: 'Attacks' }))

      expect(onChange).toHaveBeenCalledTimes(0)
    })
  })

  // Arrow-key roving-focus navigation is Radix-native. happy-dom cannot
  // reliably drive programmatic focus movement through Radix's internal
  // roving-focus handler. These scenarios are deferred to Playwright
  // e2e (e2e/tabs.spec.ts — deferred to orchestrator for U11).
})
