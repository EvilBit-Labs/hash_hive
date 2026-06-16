import { Navigate, Outlet } from 'react-router'

import { authClient } from '../../lib/auth-client'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'

export function ProtectedRoute() {
  const { data: session, isPending } = authClient.useSession()
  const hasFetchedProjects = useAuthStore((s) => s.hasFetchedProjects)
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  // On a hard load `selectedProjectId` is null until fetchProjects() resolves
  // (it is not persisted -- it mirrors the server session.projectId). Wait for
  // that fetch before deciding a project is missing, otherwise a deep link /
  // refresh of a sub-route redirects away before state hydrates and the
  // requested route is lost. Mirrors the same gate in pages/login.tsx.
  // `hasFetchedProjects` flips true in both the success and failure branches of
  // fetchProjects, so this can never hang.
  if (isPending || (session && !hasFetchedProjects)) {
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
