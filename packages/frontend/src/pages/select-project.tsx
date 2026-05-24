import { Navigate } from 'react-router'

import logoSvg from '../assets/logo.svg'
import { EmptyState } from '../components/ui/empty-state'
import { authClient } from '../lib/auth-client'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'

export function SelectProjectPage() {
  const { data: session, isPending } = authClient.useSession()
  const { projects } = useAuthStore()
  const { selectedProjectId, setSelectedProject } = useUiStore()

  if (isPending) {
    return (
      <div className="bg-crust flex h-screen items-center justify-center">
        <EmptyState message="Loading..." />
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  if (selectedProjectId) {
    return <Navigate to="/" replace />
  }

  const handleSelect = (projectId: number) => {
    setSelectedProject(projectId)
  }

  return (
    <div className="bg-crust flex min-h-screen items-center justify-center">
      <div className="border-surface-0/50 bg-mantle w-full max-w-md space-y-6 rounded-lg border p-8">
        <div className="flex flex-col items-center gap-3">
          <img src={logoSvg} alt="" className="h-10 w-10" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">Select Project</h1>
            <p className="text-muted-foreground mt-1 text-xs">Choose a project to continue</p>
          </div>
        </div>

        {projects.length === 0 ? (
          <EmptyState
            message="No projects available. Contact an administrator."
            className="text-center"
          />
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                onClick={() => handleSelect(project.projectId)}
                className="border-surface-0 bg-background hover:border-primary/30 hover:bg-surface-0/40 w-full rounded-md border px-4 py-3 text-left transition-all disabled:opacity-50"
              >
                <div className="text-foreground text-sm font-medium">{project.projectName}</div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {project.roles.join(', ')}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
