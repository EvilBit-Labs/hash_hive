import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ChartErrorBoundaryProps {
  readonly children: ReactNode
  /** Rendered in place of the chart when an error is caught. */
  readonly fallback: ReactNode
  /** Optional hook for logging the error (defaults to console.error in dev). */
  readonly onError?: (error: Error, info: ErrorInfo) => void
}

interface ChartErrorBoundaryState {
  hasError: boolean
}

/**
 * Bounds the blast radius of a Recharts render failure to one chart instead
 * of the whole dashboard. Recharts has historically thrown on malformed
 * payload shapes, version skew with React, and zero-dimension parents under
 * specific layout edge cases — without a boundary, any one sparkline can
 * unmount the entire stat grid + crack-rate chart + header.
 *
 * Uses a class component because React's error-boundary API has no hooks
 * equivalent. Keep this component small and dependency-free.
 */
export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  override state: ChartErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ChartErrorBoundaryState {
    return { hasError: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    if (this.props.onError) {
      this.props.onError(error, info)
      return
    }
    if (import.meta.env.MODE !== 'production') {
      console.error('[ChartErrorBoundary] caught', error, info)
    }
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}
