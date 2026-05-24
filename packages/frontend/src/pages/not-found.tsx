import { Link } from 'react-router'

import { buttonVariants } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
      <p className="text-surface-2 font-mono text-6xl font-bold">404</p>
      <EmptyState message="Page not found" />
      <Link to="/" className={buttonVariants()}>
        Back to Dashboard
      </Link>
    </div>
  )
}
