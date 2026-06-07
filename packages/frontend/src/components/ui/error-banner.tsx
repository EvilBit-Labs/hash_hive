import { cn } from '../../lib/utils'

interface ErrorBannerProps {
  readonly message: string
  readonly className?: string
}

export function ErrorBanner({ message, className }: ErrorBannerProps) {
  return (
    <div
      className={cn(
        'rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className
      )}
      role="alert"
    >
      {message}
    </div>
  )
}
