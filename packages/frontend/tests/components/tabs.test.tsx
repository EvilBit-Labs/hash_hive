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
 * Test harness that owns the active value the same way a real call site
 * would. Keeps the Tabs primitive controlled and lets tests observe the
 * `onChange` payload while keeping the rendered selection in sync.
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

describe('Tabs', () => {
  describe('rendering', () => {
    it('renders only the active tab panel when value matches a trigger', () => {
      render(<TabsHarness initial="results" />)

      expect(screen.getByText('results panel')).toBeDefined()
      expect(screen.queryByText('attacks panel')).toBeNull()
      expect(screen.queryByText('agents panel')).toBeNull()
    })

    it('renders no panel when value does not match any trigger', () => {
      render(<TabsHarness initial="nonexistent" />)

      expect(screen.queryByText('attacks panel')).toBeNull()
      expect(screen.queryByText('results panel')).toBeNull()
      expect(screen.queryByText('agents panel')).toBeNull()
      expect(screen.queryByRole('tabpanel')).toBeNull()
    })

    it('clicking an inactive trigger calls onChange with that value', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      fireEvent.click(screen.getByRole('tab', { name: 'Results' }))

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith('results')
      expect(screen.getByText('results panel')).toBeDefined()
    })
  })

  describe('accessibility', () => {
    it('exposes correct ARIA roles and selection state', () => {
      render(<TabsHarness initial="results" />)

      const tablist = screen.getByRole('tablist')
      expect(tablist.getAttribute('aria-label')).toBe('Sections')

      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(3)

      const activeTab = screen.getByRole('tab', { name: 'Results' })
      expect(activeTab.getAttribute('aria-selected')).toBe('true')
      expect(activeTab.getAttribute('tabindex')).toBe('0')

      const inactiveTab = screen.getByRole('tab', { name: 'Attacks' })
      expect(inactiveTab.getAttribute('aria-selected')).toBe('false')
      expect(inactiveTab.getAttribute('tabindex')).toBe('-1')

      expect(screen.getByRole('tabpanel')).toBeDefined()
    })
  })

  describe('keyboard navigation', () => {
    it('ArrowRight moves focus and selection to the next trigger', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      const first = screen.getByRole('tab', { name: 'Attacks' })
      first.focus()
      fireEvent.keyDown(first, { key: 'ArrowRight' })

      expect(onChange).toHaveBeenLastCalledWith('results')
      const next = screen.getByRole('tab', { name: 'Results' })
      expect(document.activeElement).toBe(next)
      expect(next.getAttribute('aria-selected')).toBe('true')
    })

    it('ArrowLeft moves focus and selection to the previous trigger', () => {
      const onChange = mock()
      render(<TabsHarness initial="results" onChange={onChange} />)

      const current = screen.getByRole('tab', { name: 'Results' })
      current.focus()
      fireEvent.keyDown(current, { key: 'ArrowLeft' })

      expect(onChange).toHaveBeenLastCalledWith('attacks')
      const prev = screen.getByRole('tab', { name: 'Attacks' })
      expect(document.activeElement).toBe(prev)
    })

    it('ArrowRight on the last trigger wraps to the first', () => {
      const onChange = mock()
      render(<TabsHarness initial="agents" onChange={onChange} />)

      const last = screen.getByRole('tab', { name: 'Agents' })
      last.focus()
      fireEvent.keyDown(last, { key: 'ArrowRight' })

      expect(onChange).toHaveBeenLastCalledWith('attacks')
      const first = screen.getByRole('tab', { name: 'Attacks' })
      expect(document.activeElement).toBe(first)
    })

    it('ArrowLeft on the first trigger wraps to the last', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      const first = screen.getByRole('tab', { name: 'Attacks' })
      first.focus()
      fireEvent.keyDown(first, { key: 'ArrowLeft' })

      expect(onChange).toHaveBeenLastCalledWith('agents')
      const last = screen.getByRole('tab', { name: 'Agents' })
      expect(document.activeElement).toBe(last)
    })

    it('Enter activates the focused trigger', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      const target = screen.getByRole('tab', { name: 'Results' })
      target.focus()
      fireEvent.keyDown(target, { key: 'Enter' })

      expect(onChange).toHaveBeenLastCalledWith('results')
      expect(screen.getByText('results panel')).toBeDefined()
    })

    it('Space activates the focused trigger', () => {
      const onChange = mock()
      render(<TabsHarness initial="attacks" onChange={onChange} />)

      const target = screen.getByRole('tab', { name: 'Agents' })
      target.focus()
      fireEvent.keyDown(target, { key: ' ' })

      expect(onChange).toHaveBeenLastCalledWith('agents')
      expect(screen.getByText('agents panel')).toBeDefined()
    })
  })
})
