import { motion, useReducedMotion } from 'motion/react'

import { EASE_OUT_EXPO, RESULTS_POLL_INTERVAL_MS } from '../../../lib/motion-tokens'

const PULSE_DURATION_S = 2.4

/**
 * Subtle "Live" affordance that pulses while the surrounding Results
 * surface polls. Communicates the polling cadence per `.impeccable.md`'s
 * "color + non-color cue + label" rule (the dot is the color; the
 * visible "Live" text is the label). The dot uses `bg-success`
 * (Catppuccin green) so the "we're catching cracks" semantic is
 * consistent with the plaintext cell color.
 *
 * Reduced-motion users see a static dot — the label still reads
 * "Live" so they understand the state without the animation.
 *
 * The cadence in the aria-label is computed from the shared
 * `RESULTS_POLL_INTERVAL_MS` constant so changes to the polling
 * interval surface to screen-reader users automatically.
 */
export function LiveIndicator() {
  const prefersReducedMotion = useReducedMotion()
  const cadenceSeconds = Math.round(RESULTS_POLL_INTERVAL_MS / 1000)
  return (
    <span
      aria-label={`Live - auto-refreshing every ${cadenceSeconds} seconds`}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
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
            ease: EASE_OUT_EXPO,
            repeat: Number.POSITIVE_INFINITY,
          }}
        />
      )}
      Live
    </span>
  )
}
