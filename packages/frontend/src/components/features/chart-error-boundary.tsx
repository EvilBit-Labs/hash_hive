import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ChartErrorBoundaryProps {
  readonly children: ReactNode
  /** Rendered in place of the chart when an error is caught. */
  readonly fallback: ReactNode
  /** Optional hook for logging the error (defaults to console.error in dev). */
  readonly onError?: (error: Error, info: ErrorInfo) => void
  /**
   * When this value changes between renders, the boundary clears its
   * caught-error state and re-mounts the children. Recharts can throw
   * on transient inputs (zero-dimension parents during a layout pass,
   * a one-off malformed payload). Without a reset signal, one such
   * throw locks the chart into the fallback for the rest of the
   * session. The dashboard passes the data series length so a fresh
   * sample after the bad one recovers the chart.
   */
  readonly resetKey?: string | number
}

interface ChartErrorBoundaryState {
  hasError: boolean
  resetKey: string | number | undefined
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
  override state: ChartErrorBoundaryState = {
    hasError: false,
    resetKey: this.props.resetKey,
  }

  static getDerivedStateFromError(): Partial<ChartErrorBoundaryState> {
    return { hasError: true }
  }

  static getDerivedStateFromProps(
    nextProps: ChartErrorBoundaryProps,
    prevState: ChartErrorBoundaryState
  ): Partial<ChartErrorBoundaryState> | null {
    if (nextProps.resetKey !== prevState.resetKey) {
      return { hasError: false, resetKey: nextProps.resetKey }
    }
    return null
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
