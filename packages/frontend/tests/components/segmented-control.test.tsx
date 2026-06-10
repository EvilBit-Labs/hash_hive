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
  it('renders one button per option and marks the matching value active', () => {
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="cracked"
        onChange={() => {}}
        options={OPTIONS}
      />
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(OPTIONS.length)

    const cracked = screen.getByRole('button', { name: 'Cracked' })
    expect(cracked.getAttribute('aria-pressed')).toBe('true')

    const all = screen.getByRole('button', { name: 'All' })
    const uncracked = screen.getByRole('button', { name: 'Uncracked' })
    expect(all.getAttribute('aria-pressed')).toBe('false')
    expect(uncracked.getAttribute('aria-pressed')).toBe('false')
  })

  it('calls onChange with the option value when a button is clicked', () => {
    const onChange = mock()
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="all"
        onChange={onChange}
        options={OPTIONS}
      />
    )

    screen.getByRole('button', { name: 'Uncracked' }).click()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('uncracked')
  })

  it('leaves every button inactive when value matches no option', () => {
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="nonexistent"
        onChange={() => {}}
        options={OPTIONS}
      />
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('exposes the aria-label on a role="group" container', () => {
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="all"
        onChange={() => {}}
        options={OPTIONS}
      />
    )

    const group = screen.getByRole('group', { name: 'Filter results' })
    expect(group).toBeDefined()
  })

  it('moves selection right on ArrowRight, wrapping past the last option', () => {
    const onChange = mock()
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="cracked"
        onChange={onChange}
        options={OPTIONS}
      />
    )

    const cracked = screen.getByRole('button', { name: 'Cracked' })
    fireEvent.keyDown(cracked, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('uncracked')

    const uncracked = screen.getByRole('button', { name: 'Uncracked' })
    fireEvent.keyDown(uncracked, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('all')
  })

  it('moves selection left on ArrowLeft, wrapping before the first option', () => {
    const onChange = mock()
    render(
      <SegmentedControl
        aria-label="Filter results"
        value="cracked"
        onChange={onChange}
        options={OPTIONS}
      />
    )

    const cracked = screen.getByRole('button', { name: 'Cracked' })
    fireEvent.keyDown(cracked, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('all')

    const all = screen.getByRole('button', { name: 'All' })
    fireEvent.keyDown(all, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('uncracked')
  })
})
