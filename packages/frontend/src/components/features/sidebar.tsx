import {
  Cpu,
  Crosshair,
  KeyRound,
  Layers,
  LayoutDashboard,
  Monitor,
  Package,
  Trophy,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { Link, useLocation } from 'react-router'
import { useShallow } from 'zustand/shallow'

import logoSvg from '../../assets/logo.svg'
import { useLogout } from '../../hooks/use-logout'
import { usePermissions } from '../../hooks/use-permissions'
import { useSelectProject } from '../../hooks/use-select-project'
import { authClient } from '../../lib/auth-client'
import { Permission, type PermissionKey } from '../../lib/permissions'
import { cn } from '../../lib/utils'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { Select } from '../ui/select'
import { ConnectionIndicator } from './connection-indicator'

const ICON_CLASS = 'h-4 w-4'

interface NavItem {
  label: string
  href: string
  icon: ReactNode
  /** Optional permission required to render this entry. */
  permission?: PermissionKey
}

const navItems: readonly NavItem[] = [
  {
    label: 'Dashboard',
    href: '/',
    icon: <LayoutDashboard className={ICON_CLASS} aria-hidden="true" />,
  },
  {
    label: 'Campaigns',
    href: '/campaigns',
    icon: <Crosshair className={ICON_CLASS} aria-hidden="true" />,
  },
  {
    label: 'Templates',
    href: '/attack-templates',
    icon: <Layers className={ICON_CLASS} aria-hidden="true" />,
  },
  { label: 'Agents', href: '/agents', icon: <Monitor className={ICON_CLASS} aria-hidden="true" /> },
  {
    label: 'Resources',
    href: '/resources',
    icon: <Package className={ICON_CLASS} aria-hidden="true" />,
  },
  {
    label: 'Results',
    href: '/results',
    icon: <Trophy className={ICON_CLASS} aria-hidden="true" />,
  },
  {
    label: 'Crackers',
    href: '/crackers',
    icon: <Cpu className={ICON_CLASS} aria-hidden="true" />,
    permission: Permission.CRACKER_MANAGE,
  },
  {
    label: 'Account',
    href: '/account',
    icon: <KeyRound className={ICON_CLASS} aria-hidden="true" />,
  },
]

/** Shared sidebar content used by both desktop and mobile variants. */
function SidebarContent({ onNavigate }: { readonly onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const projects = useAuthStore((s) => s.projects)
  const { data: session } = authClient.useSession()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const { can } = usePermissions()
  const selectProject = useSelectProject()
  const logout = useLogout()

  const visibleNavItems = useMemo(
    () => navItems.filter((item) => !item.permission || can(item.permission)),
    [can]
  )

  const handleProjectChange = (value: string) => {
    // Gate re-entry while a switch is in flight. Overlapping mutations
    // can resolve out of order; if a slower earlier POST settles after
    // a later one, onSuccess would write the stale projectId back into
    // the UI store and invalidate queries for the wrong scope.
    if (selectProject.isPending) return
    // The "All Projects" option (`''`) is a no-op: the server requires
    // a concrete projectId on the session, so we can't clear scope from
    // the sidebar.
    if (!value) return
    const projectId = Number(value)
    if (!Number.isFinite(projectId)) return
    selectProject.mutate(projectId)
  }

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))

  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <img src={logoSvg} alt="" className="h-7 w-7" />
        <span className="text-base font-semibold tracking-tight text-foreground">HashHive</span>
      </div>

      {/* Project selector */}
      {projects.length > 0 && (
        <div className="px-3 pb-3">
          <Select
            aria-label="Select project"
            className="px-2.5 py-1.5 text-xs"
            value={selectedProjectId ?? ''}
            disabled={selectProject.isPending}
            onChange={(e) => handleProjectChange(e.target.value)}
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectName}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-2 py-1">
        {visibleNavItems.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              to={item.href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-2.5 rounded px-2.5 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-surface-0/60 hover:text-foreground'
              )}
            >
              <span className={cn(active ? 'text-primary' : 'text-muted-foreground')}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="space-y-2 border-t border-surface-0/50 px-3 py-3">
        <ConnectionIndicator />
        <div className="flex items-center justify-between">
          <span className="max-w-[130px] truncate text-xs text-muted-foreground">
            {session?.user.email}
          </span>
          <button
            type="button"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              void logout()
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </>
  )
}

/** Desktop sidebar - hidden below md breakpoint. */
export function Sidebar() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)

  if (!sidebarOpen) return null

  return (
    <aside className="hidden h-screen w-56 flex-col border-r border-surface-0/50 bg-mantle md:flex">
      <SidebarContent />
    </aside>
  )
}

/** Mobile sidebar - slides in as an overlay drawer below md. */
export function MobileSidebar() {
  const { mobileSidebarOpen, setMobileSidebar } = useUiStore(
    useShallow((s) => ({
      mobileSidebarOpen: s.mobileSidebarOpen,
      setMobileSidebar: s.setMobileSidebar,
    }))
  )
  const { pathname } = useLocation()
  const prevPathname = useRef(pathname)

  // Close drawer on route change
  useEffect(() => {
    if (pathname !== prevPathname.current) {
      prevPathname.current = pathname
      setMobileSidebar(false)
    }
  }, [pathname, setMobileSidebar])

  // Close on Escape key
  useEffect(() => {
    if (!mobileSidebarOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileSidebar(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mobileSidebarOpen, setMobileSidebar])

  if (!mobileSidebarOpen) return null

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close navigation menu"
        className="absolute inset-0 bg-crust/80"
        onClick={() => setMobileSidebar(false)}
      />

      {/* Drawer */}
      <aside className="relative flex h-full w-64 flex-col bg-mantle shadow-2xl">
        {/* Close button */}
        <button
          type="button"
          aria-label="Close navigation menu"
          className="absolute top-3 right-2 flex h-9 w-9 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground"
          onClick={() => setMobileSidebar(false)}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <SidebarContent onNavigate={() => setMobileSidebar(false)} />
      </aside>
    </div>
  )
}
