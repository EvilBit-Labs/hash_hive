import { cn } from '../../lib/utils'

interface ErrorBannerProps {
  readonly message: string
  readonly className?: string
}

export function ErrorBanner({ message, className }: ErrorBannerProps) {
  return (
    <div
      className={cn(
        'border-destructive/20 bg-destructive/10 text-destructive rounded border px-3 py-2 text-sm',
        className
      )}
      role="alert"
    >
      {message}
    </div>
  )
}
