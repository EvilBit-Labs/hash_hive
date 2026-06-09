import { motion, useReducedMotion } from 'motion/react'

/**
 * Subtle "Live" affordance that pulses while the surrounding Results
 * surface polls every 30s. Communicates the polling cadence per
 * .impeccable.md design principle 3 (signal = color + non-color
 * cue + label). The dot uses `bg-success` (Catppuccin green) so the
 * "we're catching cracks" semantic is consistent with the plaintext
 * cell color.
 *
 * Reduced-motion users see a static dot — the label still reads "Live"
 * so they understand the state without the animation.
 */
const PULSE_DURATION_S = 2.4
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

export function LiveIndicator() {
  const prefersReducedMotion = useReducedMotion()
  return (
    <span
      aria-label="Live — auto-refreshing every 30 seconds"
      className="inline-flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground"
    >
      {prefersReducedMotion ? (
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
      ) : (
        <motion.span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-success"
          animate={{ opacity: [1, 0.35, 1] }}
          transition={{
            duration: PULSE_DURATION_S,
            ease: [...EASE_OUT_EXPO],
            repeat: Number.POSITIVE_INFINITY,
          }}
        />
      )}
      Live
    </span>
  )
}
