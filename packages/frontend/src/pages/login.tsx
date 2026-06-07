import type { LoginRequest } from '@hashhive/shared'

import { loginRequestSchema } from '@hashhive/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate } from 'react-router'

import logoSvg from '../assets/logo.svg'
import { Button } from '../components/ui/button'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { useSelectProject } from '../hooks/use-select-project'
import { authClient } from '../lib/auth-client'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'

export function LoginPage() {
  const { data: session } = authClient.useSession()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const fetchProjects = useAuthStore((s) => s.fetchProjects)
  const hasFetchedProjects = useAuthStore((s) => s.hasFetchedProjects)
  const [error, setError] = useState<string | null>(null)
  const selectProject = useSelectProject()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
  })

  // Redirect when session is active + project selected (reactive, no race condition)
  if (session && selectedProjectId) {
    return <Navigate to="/" replace />
  }

  // Redirect to project selection when authenticated but no project auto-selected
  if (session && hasFetchedProjects && !selectedProjectId) {
    return <Navigate to="/select-project" replace />
  }

  const onSubmit = async (data: LoginRequest) => {
    setError(null)
    const { error: signInError } = await authClient.signIn.email({
      email: data.email,
      password: data.password,
    })

    if (signInError) {
      setError(signInError.message ?? 'Invalid email or password')
      return
    }

    // Fetch project memberships -- syncSelectedProject auto-selects when the
    // server has pre-selected (single-project user, or BetterAuth restored
    // a previous session.projectId). The store's catch swallows /me errors
    // and clears state, but we still surface a user-visible message rather
    // than leaving the form silently stuck.
    try {
      await fetchProjects()
    } catch {
      setError('Failed to load projects. Please try again.')
      return
    }

    // Honor "remember last project" when the server hasn't pre-selected.
    // syncSelectedProject already won for single-project / server-set cases,
    // so we only need to handle the multi-project no-server-selection case.
    const ui = useUiStore.getState()
    if (ui.selectedProjectId === null && ui.rememberLastProject && ui.lastProjectId !== null) {
      const projects = useAuthStore.getState().projects
      const stillMember = projects.some((p) => p.projectId === ui.lastProjectId)
      if (stillMember) {
        try {
          await selectProject.mutateAsync(ui.lastProjectId)
        } catch {
          // Selection failed (membership stale despite local check, RBAC
          // tightened, transient server error). Fall through to the
          // selector page rather than stranding the user.
        }
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-crust">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-surface-0/50 bg-mantle p-8">
        <div className="flex flex-col items-center gap-3">
          <img src={logoSvg} alt="" className="h-12 w-12" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">HashHive</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Distributed hash cracking management
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && <ErrorBanner message={error} />}

          <div>
            <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
              Email
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              className="mt-1.5"
              placeholder="operator@lab.local"
              {...register('email')}
            />
            {errors.email && (
              <p className="mt-1 text-xs text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              className="mt-1.5"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-destructive">{errors.password.message}</p>
            )}
          </div>

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? 'Authenticating...' : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  )
}
