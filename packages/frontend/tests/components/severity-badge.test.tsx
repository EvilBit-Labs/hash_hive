import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { SeverityBadge } from '../../src/components/features/severity-badge'
import { cleanupAll, renderWithProviders } from '../test-utils'

afterEach(cleanupAll)

describe('SeverityBadge', () => {
  it('renders the severity text', () => {
    renderWithProviders(<SeverityBadge severity="warning" />)
    expect(screen.getByText('warning')).toBeDefined()
  })

  it('applies warning styling for warning severity', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="warning" />)
    const badge = container.querySelector('span.inline-flex')
    expect(badge?.className).toContain('text-warning')
  })

  it('applies destructive styling for fatal severity', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="fatal" />)
    const badge = container.querySelector('span.inline-flex')
    expect(badge?.className).toContain('text-destructive')
  })

  it('applies destructive styling for critical severity', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="critical" />)
    const badge = container.querySelector('span.inline-flex')
    expect(badge?.className).toContain('text-destructive')
  })

  it('uses neutral styling for unknown / informational severities', () => {
    // Unknown severities (info/debug/notice/...) intentionally do NOT use the
    // destructive style — the backend filters them out of the badge count and
    // the visual treatment must match.
    const { container } = renderWithProviders(<SeverityBadge severity="info" />)
    const badge = container.querySelector('span.inline-flex')
    expect(badge?.className).toContain('text-muted-foreground')
    expect(badge?.className).not.toContain('text-destructive')
    expect(badge?.className).not.toContain('text-warning')
  })

  it('applies destructive styling for error severity (matching backend fatal allowlist)', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="error" />)
    const badge = container.querySelector('span.inline-flex')
    expect(badge?.className).toContain('text-destructive')
  })
})
