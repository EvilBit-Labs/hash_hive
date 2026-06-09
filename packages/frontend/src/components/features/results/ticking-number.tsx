import { motion, useReducedMotion } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

interface TickingNumberProps {
  /** Current value to render. Numerical formatting is the caller's job. */
  readonly value: number
  /** Pre-formatted text to display (e.g. `1,283`). */
  readonly children: ReactNode
  /** Extra classes for the rendered span. */
  readonly className?: string
}

const TICK_DURATION_S = 0.5
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

/**
 * Wraps a numeric figure so it briefly acknowledges when its value
 * goes UP between renders — the inline counterpart to the
 * ResultsTable row pulse. Filter changes (which often drop the value
 * to zero before refilling) are excluded by the `prev > 0` guard,
 * so the tick only fires on poll-driven crack arrivals.
 *
 * The pulse is opacity + a tiny scale lift (0.97 -> 1) — Motion-only,
 * no chrome motion, no Tailwind transition classes (those would
 * conflict with Motion's timing per CLAUDE.md). Reduced-motion users
 * see the figure update without animation.
 */
export function TickingNumber({ value, children, className }: TickingNumberProps) {
  const prefersReducedMotion = useReducedMotion()
  const prevValueRef = useRef(value)
  const [tickKey, setTickKey] = useState(0)

  useEffect(() => {
    const prev = prevValueRef.current
    if (prev > 0 && value > prev) {
      setTickKey((k) => k + 1)
    }
    prevValueRef.current = value
  }, [value])

  if (prefersReducedMotion) {
    return <span className={className}>{children}</span>
  }

  return (
    <motion.span
      key={tickKey}
      initial={tickKey === 0 ? false : { opacity: 0.55, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: TICK_DURATION_S, ease: [...EASE_OUT_EXPO] }}
      className={className}
    >
      {children}
    </motion.span>
  )
}
