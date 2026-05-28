import { useState } from 'react'
import { Navigate } from 'react-router'
import { useShallow } from 'zustand/shallow'

import logoSvg from '../assets/logo.svg'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { useSelectProject } from '../hooks/use-select-project'
import { authClient } from '../lib/auth-client'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'

export function SelectProjectPage() {
  const { data: session, isPending } = authClient.useSession()
  const projects = useAuthStore((s) => s.projects)
  const { selectedProjectId, rememberLastProject, setRememberLastProject, setLastProjectId } =
    useUiStore(
      useShallow((s) => ({
        selectedProjectId: s.selectedProjectId,
        rememberLastProject: s.rememberLastProject,
        setRememberLastProject: s.setRememberLastProject,
        setLastProjectId: s.setLastProjectId,
      }))
    )
  const [error, setError] = useState<string | null>(null)
  const selectProject = useSelectProject({
    onError: (msg) => {
      setError(msg)
    },
  })

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
    setError(null)
    selectProject.mutate(projectId, {
      onSuccess: () => {
        // Capture the user's intent only when they've opted in. The
        // store hook reads the latest `rememberLastProject` directly
        // so a toggle change between click and resolve is honored.
        if (useUiStore.getState().rememberLastProject) {
          setLastProjectId(projectId)
        }
      },
    })
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

        {error && <ErrorBanner message={error} />}

        {projects.length === 0 ? (
          <EmptyState
            message="No projects available. Contact an administrator."
            className="text-center"
          />
        ) : (
          <>
            <div className="space-y-2">
              {projects.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  disabled={selectProject.isPending}
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

            <label
              htmlFor="remember-last-project"
              className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs"
            >
              <input
                id="remember-last-project"
                type="checkbox"
                aria-label="Remember this project on next sign-in"
                checked={rememberLastProject}
                onChange={(e) => setRememberLastProject(e.target.checked)}
                className="border-surface-0 h-3.5 w-3.5 rounded"
              />
              Remember this project on next sign-in
            </label>
          </>
        )}
      </div>
    </div>
  )
}
