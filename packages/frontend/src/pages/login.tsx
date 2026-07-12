import type { LdapSignInBody, LoginRequest } from '@hashhive/shared'

import { ldapSignInBodySchema, loginRequestSchema } from '@hashhive/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { Building2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate } from 'react-router'

import logoSvg from '../assets/logo.svg'
import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { useAuthMethods } from '../hooks/use-auth-methods'
import { useSelectProject } from '../hooks/use-select-project'
import { authClient, signInLdap, type LdapSignInError } from '../lib/auth-client'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'

/**
 * Maps a typed `/sign-in/ldap` failure (R22: 401 / 403 / 503 / 409) to
 * user-facing copy. Every branch is a distinct, friendly message; nothing
 * here forwards a raw status or stack trace. The 409 (collision) message
 * deliberately stays generic about WHY reconciliation is needed -- it
 * never confirms which account the directory identity collided with, so
 * it carries no account-enumeration signal beyond "an admin needs to look
 * at this," which is only ever reachable after a directory credential
 * check already succeeded (never on a bad password).
 */
function directoryErrorMessage(err: LdapSignInError): string {
  switch (err.status) {
    case 401:
      return 'Invalid directory username or password.'
    case 403:
      return err.code === 'LDAP_ROLE_SYNC_BLOCKED'
        ? 'This directory sign-in was blocked to protect the last local administrator. Contact an admin.'
        : 'Your directory account is not a member of a group mapped to HashHive access.'
    case 503:
      return 'The directory server is unavailable. Try again shortly, or sign in with a local account below.'
    case 409:
      return 'This account needs an administrator to link it before you can sign in this way. Contact an admin.'
    default:
      return err.message ?? 'Directory sign-in failed. Please try again.'
  }
}

export function LoginPage() {
  const { data: session } = authClient.useSession()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const fetchProjects = useAuthStore((s) => s.fetchProjects)
  const hasFetchedProjects = useAuthStore((s) => s.hasFetchedProjects)
  const [error, setError] = useState<string | null>(null)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const selectProject = useSelectProject()
  const { data: authMethods } = useAuthMethods()
  const showDirectoryOption = authMethods?.ldap === true

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    clearErrors,
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
  })

  const {
    register: registerDirectory,
    handleSubmit: handleDirectorySubmit,
    formState: { errors: directoryErrors, isSubmitting: isDirectorySubmitting },
    clearErrors: clearDirectoryErrors,
    setFocus: setDirectoryFocus,
  } = useForm<LdapSignInBody>({
    resolver: zodResolver(ldapSignInBodySchema),
  })

  // Focus moves into the revealed fields on disclosure (WAI-ARIA disclosure
  // pattern). Uses react-hook-form's imperative setFocus rather than the
  // JSX `autoFocus` attribute -- `autoFocus` fires unconditionally on
  // mount regardless of WHY the element mounted (including page load),
  // which is the footgun jsx-a11y/no-autofocus flags; this only moves
  // focus in direct response to the operator's own trigger click.
  useEffect(() => {
    if (directoryOpen) {
      setDirectoryFocus('username')
    }
  }, [directoryOpen, setDirectoryFocus])

  // Redirect when session is active + project selected (reactive, no race condition)
  if (session && selectedProjectId) {
    return <Navigate to="/" replace />
  }

  // Redirect to project selection when authenticated but no project auto-selected
  if (session && hasFetchedProjects && !selectedProjectId) {
    return <Navigate to="/select-project" replace />
  }

  // Shared post-sign-in flow (R21: local and directory reach the same
  // project-selection outcome, just via distinct, explicitly chosen entry
  // points -- neither infers the other's identifier format).
  const applyRememberedProjectSelection = async () => {
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

  // Explicit toggle for the directory disclosure (R21). Clears BOTH
  // forms' validation errors and the shared banner on every switch, so
  // stale state from one path never bleeds into the other.
  const handleDirectoryToggle = (open: boolean) => {
    setDirectoryOpen(open)
    setError(null)
    clearErrors()
    clearDirectoryErrors()
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

    await applyRememberedProjectSelection()
  }

  const onSubmitDirectory = async (data: LdapSignInBody) => {
    setError(null)
    const { error: signInError } = await signInLdap(data)

    if (signInError) {
      setError(directoryErrorMessage(signInError))
      return
    }

    // signInLdap calls authClient.$fetch directly rather than a registered
    // client plugin action (see auth-client.ts), so it does not
    // participate in BetterAuth's built-in atomListeners session-refresh
    // matcher. Notify the session signal manually so useSession() picks
    // up the cookie the endpoint just set -- the same effect the matcher
    // produces automatically for /sign-in/email.
    authClient.$store.notify('$sessionSignal')

    try {
      await fetchProjects()
    } catch {
      setError('Failed to load projects. Please try again.')
      return
    }

    await applyRememberedProjectSelection()
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

        {error && <ErrorBanner message={error} />}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

        {showDirectoryOption && (
          <Collapsible open={directoryOpen} onOpenChange={handleDirectoryToggle}>
            <div className="flex items-center gap-3" aria-hidden="true">
              <div className="h-px flex-1 bg-surface-1" />
              <span className="text-[0.65rem] tracking-wide text-muted-foreground uppercase">
                or
              </span>
              <div className="h-px flex-1 bg-surface-1" />
            </div>

            <CollapsibleTrigger asChild>
              <Button variant="secondary" className="mt-4 w-full gap-2">
                <Building2 className="h-4 w-4" aria-hidden="true" />
                {directoryOpen ? 'Use email & password instead' : 'Sign in with Directory'}
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <form onSubmit={handleDirectorySubmit(onSubmitDirectory)} className="mt-4 space-y-4">
                <div>
                  <label
                    htmlFor="directory-username"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Directory Username
                  </label>
                  <Input
                    id="directory-username"
                    type="text"
                    autoComplete="username"
                    className="mt-1.5"
                    placeholder="jdoe"
                    {...registerDirectory('username')}
                  />
                  {directoryErrors.username && (
                    <p className="mt-1 text-xs text-destructive">
                      {directoryErrors.username.message}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="directory-password"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Directory Password
                  </label>
                  <Input
                    id="directory-password"
                    type="password"
                    autoComplete="current-password"
                    className="mt-1.5"
                    {...registerDirectory('password')}
                  />
                  {directoryErrors.password && (
                    <p className="mt-1 text-xs text-destructive">
                      {directoryErrors.password.message}
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  variant="secondary"
                  disabled={isDirectorySubmitting}
                  className="w-full"
                >
                  {isDirectorySubmitting ? 'Authenticating...' : 'Continue with Directory'}
                </Button>
              </form>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  )
}
