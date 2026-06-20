import { Check, Copy } from 'lucide-react'

import { useCopyToClipboard } from '../../hooks/use-copy-to-clipboard'
import { cn } from '../../lib/utils'

interface CopyableBlockProps {
  /** Text shown in the block and written to the clipboard on copy. */
  readonly value: string
  /** Accessible label for the copy button at rest. */
  readonly ariaLabel: string
  /** Accessible label announced for the brief "copied" flash. */
  readonly copiedLabel?: string
  /** Render on a single non-wrapping line (e.g. a bare token) vs a command. */
  readonly oneLine?: boolean
  readonly className?: string
}

/**
 * A monospace block with a corner copy button and a manual-copy fallback.
 * Shared across the first-run surfaces (enroll command, enrollment token,
 * Control API key) so copy behaviour, the insecure-context guard, and the
 * fallback message never drift between them. Copy logic lives in
 * `useCopyToClipboard`; this component owns only the presentation.
 */
export function CopyableBlock({
  value,
  ariaLabel,
  copiedLabel = 'Copied',
  oneLine = false,
  className,
}: CopyableBlockProps) {
  const { copied, copyFailed, copy } = useCopyToClipboard()

  return (
    <div className={cn('relative', className)}>
      <pre
        className={cn(
          'overflow-x-auto rounded border border-surface-1 bg-surface-0/70 p-3 pr-12 font-mono text-xs text-foreground/90 select-all',
          oneLine ? 'whitespace-nowrap' : 'leading-relaxed'
        )}
      >
        <code>{value}</code>
      </pre>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={copied ? copiedLabel : ariaLabel}
        className={cn(
          'absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded',
          'border border-surface-1 bg-surface-0/95 transition-colors hover:bg-surface-1',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        )}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {copyFailed && (
        <p className="mt-1 text-xs text-warning">
          Copy failed - select the text and copy manually.
        </p>
      )}
    </div>
  )
}
