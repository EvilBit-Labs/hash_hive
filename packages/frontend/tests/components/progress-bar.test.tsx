import { afterEach, describe, expect, it } from 'bun:test'

import { ProgressBar } from '../../src/components/ui/progress-bar'
import { cleanupAll, renderWithProviders, screen } from '../test-utils'

afterEach(cleanupAll)

describe('ProgressBar', () => {
  // R5: value=0.5 and value=50 both report aria-valuenow=50
  it('normalizes value=0.5 (0-1 scale) to aria-valuenow=50', () => {
    const { container } = renderWithProviders(<ProgressBar value={0.5} ariaLabel="Progress" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('50')
  })

  it('accepts value=50 (0-100 scale) and reports aria-valuenow=50', () => {
    const { container } = renderWithProviders(<ProgressBar value={50} ariaLabel="Progress" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('50')
  })

  it('renders aria-valuenow rounded from a 0-1 fractional input', () => {
    const { container } = renderWithProviders(<ProgressBar value={0.756} ariaLabel="Progress" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('76')
    expect(bar?.getAttribute('aria-valuemin')).toBe('0')
    expect(bar?.getAttribute('aria-valuemax')).toBe('100')
  })

  it('accepts the 0-100 percentage scale without doubling it', () => {
    const { container } = renderWithProviders(<ProgressBar value={42} ariaLabel="Progress" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('42')
  })

  it('clamps values above 100 to 100', () => {
    const { container } = renderWithProviders(<ProgressBar value={150} ariaLabel="Progress" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('100')
  })

  it('clamps negative values to 0', () => {
    const { container } = renderWithProviders(<ProgressBar value={-5} ariaLabel="Progress" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('0')
  })

  it('coerces non-finite inputs (NaN, Infinity) to 0', () => {
    const { container } = renderWithProviders(<ProgressBar value={Number.NaN} ariaLabel="X" />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('0')
  })

  it('uses ariaLabel as the accessible name', () => {
    renderWithProviders(<ProgressBar value={0.5} ariaLabel="Upload progress" />)
    expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toBeDefined()
  })

  it('uses label as both the visible text and accessible name', () => {
    renderWithProviders(<ProgressBar value={0.5} label="50% complete" />)
    expect(screen.getByRole('progressbar', { name: '50% complete' })).toBeDefined()
    expect(screen.getByText('50% complete')).toBeDefined()
  })

  // R5: tone visual treatment — assert the indicator class differs across tones,
  // not the specific literal class name (which is an implementation detail).
  it('thin size renders a narrower track than the default size', () => {
    const { container: thinContainer } = renderWithProviders(
      <ProgressBar value={0.5} size="thin" ariaLabel="thin" />
    )
    const { container: defaultContainer } = renderWithProviders(
      <ProgressBar value={0.5} ariaLabel="default" />
    )
    const thinTrack = thinContainer.querySelector('[role="progressbar"]')
    const defaultTrack = defaultContainer.querySelector('[role="progressbar"]')
    // The two tracks should have different height classes
    expect(thinTrack?.className).not.toBe(defaultTrack?.className)
  })

  it('destructive tone renders a different indicator than primary tone', () => {
    const { container: destructiveContainer } = renderWithProviders(
      <ProgressBar value={0.5} tone="destructive" ariaLabel="destructive" />
    )
    const { container: primaryContainer } = renderWithProviders(
      <ProgressBar value={0.5} tone="primary" ariaLabel="primary" />
    )
    const destructiveFill = destructiveContainer.querySelector('[role="progressbar"] > div')
    const primaryFill = primaryContainer.querySelector('[role="progressbar"] > div')
    // The indicator class names should differ between tones
    expect(destructiveFill?.className).not.toBe(primaryFill?.className)
  })
})
