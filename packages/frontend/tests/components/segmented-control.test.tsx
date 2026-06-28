import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import {
  SegmentedControl,
  type SegmentedControlOption,
} from '../../src/components/ui/segmented-control'
import { cleanupAll, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

const OPTIONS: ReadonlyArray<SegmentedControlOption> = [
  { value: 'all', label: 'All' },
  { value: 'cracked', label: 'Cracked' },
  { value: 'uncracked', label: 'Uncracked' },
]

describe('SegmentedControl', () => {
  it('renders one radio per option and marks the matching value checked', () => {
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="cracked"
        onChange={() => {}}
        options={OPTIONS}
      />
    )

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(OPTIONS.length)

    const cracked = screen.getByRole('radio', { name: 'Cracked' })
    expect(cracked.getAttribute('aria-checked')).toBe('true')
    expect(cracked.getAttribute('data-state')).toBe('on')

    const all = screen.getByRole('radio', { name: 'All' })
    const uncracked = screen.getByRole('radio', { name: 'Uncracked' })
    expect(all.getAttribute('aria-checked')).toBe('false')
    expect(uncracked.getAttribute('aria-checked')).toBe('false')
  })

  it('calls onChange with the option value when a radio is clicked', () => {
    const onChange = mock()
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="all"
        onChange={onChange}
        options={OPTIONS}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Uncracked' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('uncracked')
  })

  it('leaves every radio unchecked when value matches no option', () => {
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="nonexistent"
        onChange={() => {}}
        options={OPTIONS}
      />
    )

    const radios = screen.getAllByRole('radio')
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
  })

  it('exposes the aria-label on a radiogroup container', () => {
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="all"
        onChange={() => {}}
        options={OPTIONS}
      />
    )

    const group = screen.getByRole('radiogroup', { name: 'Filter results' })
    expect(group).toBeDefined()
  })

  it('does NOT call onChange when the already-active option is clicked (mandatory-selection guard)', () => {
    const onChange = mock()
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="cracked"
        onChange={onChange}
        options={OPTIONS}
      />
    )

    // Click the already-active option — Radix emits '' but we must drop it
    fireEvent.click(screen.getByRole('radio', { name: 'Cracked' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('calls onChange with the next value when a different option is clicked', () => {
    const onChange = mock()
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="cracked"
        onChange={onChange}
        options={OPTIONS}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('all')
  })

  // NOTE: ArrowRight/ArrowLeft roving focus is driven by Radix's roving-tabindex
  // implementation which relies on real focus management that happy-dom cannot
  // exercise. Arrow-key navigation will be covered by Playwright e2e tests
  // (e2e/segmented-control.spec.ts). The mandatory-selection invariant and
  // click-selection are fully covered above.
})
