import { useNavigate } from 'react-router'

import { cn } from '../../lib/utils'

interface StatCardProps {
  title: string
  value: string | number
  subtitle: string
  loading?: boolean
  /** SPA route to navigate to when clicked. Omit for non-interactive card. */
  to?: string
  /** CSS custom property name for the left-border accent (e.g. "--ctp-teal"). */
  accent?: string
}

export function StatCard({ title, value, subtitle, loading, to, accent }: StatCardProps) {
  const navigate = useNavigate()

  const content = (
    <>
      <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">{title}</p>
      <p className="text-foreground mt-2 font-mono text-2xl font-bold tabular-nums">
        {loading ? '-' : value}
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>
    </>
  )

  const accentStyle = accent ? { borderLeftColor: `hsl(var(${accent}))` } : undefined

  if (to) {
    return (
      <button
        type="button"
        onClick={() => navigate(to)}
        style={accentStyle}
        className={cn(
          'group bg-surface-0/40 w-full rounded-md border p-4 text-left transition-all',
          accent ? 'border-surface-0 border-l-2' : 'border-surface-0',
          'hover:border-primary/30 hover:bg-surface-0/70 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      style={accentStyle}
      className={cn(
        'bg-surface-0/40 rounded-md border p-4',
        accent ? 'border-surface-0 border-l-2' : 'border-surface-0'
      )}
    >
      {content}
    </div>
  )
}
