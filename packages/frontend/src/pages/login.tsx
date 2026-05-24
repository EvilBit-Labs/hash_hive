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
import { authClient } from '../lib/auth-client'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'

export function LoginPage() {
  const { data: session } = authClient.useSession()
  const { selectedProjectId } = useUiStore()
  const { fetchProjects, hasFetchedProjects } = useAuthStore()
  const [error, setError] = useState<string | null>(null)

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

    // Fetch project memberships -- syncSelectedProject auto-selects if one project.
    // Navigation is handled reactively by the <Navigate> guards above when
    // useSession() picks up the new session and projects are fetched.
    await fetchProjects()
  }

  return (
    <div className="bg-crust flex min-h-screen items-center justify-center">
      <div className="border-surface-0/50 bg-mantle w-full max-w-sm space-y-6 rounded-lg border p-8">
        <div className="flex flex-col items-center gap-3">
          <img src={logoSvg} alt="" className="h-12 w-12" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">HashHive</h1>
            <p className="text-muted-foreground mt-1 text-xs">
              Distributed hash cracking management
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && <ErrorBanner message={error} />}

          <div>
            <label htmlFor="email" className="text-muted-foreground text-xs font-medium">
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
              <p className="text-destructive mt-1 text-xs">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="text-muted-foreground text-xs font-medium">
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
              <p className="text-destructive mt-1 text-xs">{errors.password.message}</p>
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
