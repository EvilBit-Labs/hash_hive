import { Navigate, Outlet } from 'react-router'

import { authClient } from '../../lib/auth-client'
import { useUiStore } from '../../stores/ui'

export function ProtectedRoute() {
  const { data: session, isPending } = authClient.useSession()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  if (!selectedProjectId) {
    return <Navigate to="/select-project" replace />
  }

  return <Outlet />
}
