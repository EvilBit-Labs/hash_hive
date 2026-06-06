import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ChartErrorBoundary } from '../../src/components/features/chart-error-boundary'
import { cleanupAll, render, screen } from '../test-utils'

function Boom(): never {
  throw new Error('chart explosion')
}

afterEach(() => {
  cleanupAll()
})

describe('ChartErrorBoundary', () => {
  it('renders the children when no error is thrown', () => {
    render(
      <ChartErrorBoundary fallback={<div data-testid="fallback" />}>
        <div data-testid="content">ok</div>
      </ChartErrorBoundary>
    )
    expect(screen.getByTestId('content')).toBeDefined()
    expect(screen.queryByTestId('fallback')).toBeNull()
  })

  it('renders the fallback when a child throws and reports via onError', () => {
    const onError = mock(() => {})
    render(
      <ChartErrorBoundary fallback={<div data-testid="fallback" />} onError={onError}>
        <Boom />
      </ChartErrorBoundary>
    )
    expect(screen.getByTestId('fallback')).toBeDefined()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
