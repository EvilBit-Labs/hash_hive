import { Link, useLocation } from 'react-router';
import logoSvg from '../../assets/logo.svg';
import { useEvents } from '../../hooks/use-events';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth';
import { useUiStore } from '../../stores/ui';
import { ConnectionIndicator } from './connection-indicator';

const navItems = [
  {
    label: 'Dashboard',
    href: '/',
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="6" height="6" rx="1" />
        <rect x="9" y="1" width="6" height="6" rx="1" />
        <rect x="1" y="9" width="6" height="6" rx="1" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    ),
  },
  {
    label: 'Campaigns',
    href: '/campaigns',
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" />
        <circle cx="8" cy="8" r="4" />
        <circle cx="8" cy="8" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    label: 'Agents',
    href: '/agents',
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M5 7h2M9 7h2M5 10h6" />
      </svg>
    ),
  },
  {
    label: 'Resources',
    href: '/resources',
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M2 4l6-2.5L14 4v3l-6 2.5L2 7V4z" />
        <path d="M2 7v3l6 2.5L14 10V7" />
        <path d="M2 10v3l6 2.5L14 13V10" />
      </svg>
    ),
  },
  {
    label: 'Results',
    href: '/results',
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M8 2v4l3 2" />
        <path d="M3.5 5A6 6 0 1012.5 5" />
        <path d="M1 8h3M12 8h3" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const { pathname } = useLocation();
  const { user, logout, selectProject } = useAuthStore();
  const { sidebarOpen, selectedProjectId, setSelectedProject } = useUiStore();
  const { connected } = useEvents();

  const handleProjectChange = async (value: string) => {
    const projectId = value ? Number(value) : null;
    setSelectedProject(projectId);
    if (projectId) {
      try {
        await selectProject(projectId);
      } catch {
        // Cookie update failed — local state is still set, next request will work
      }
    }
  };

  if (!sidebarOpen) return null;

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-surface-0/50 bg-mantle">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <img src={logoSvg} alt="" className="h-7 w-7" />
        <span className="text-base font-semibold tracking-tight text-foreground">HashHive</span>
      </div>

      {/* Project selector */}
      {user && user.projects.length > 0 && (
        <div className="px-3 pb-3">
          <select
            id="project-select"
            aria-label="Select project"
            className="w-full rounded border-surface-0 bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors focus:border-primary focus:ring-1 focus:ring-primary/40"
            value={selectedProjectId ?? ''}
            onChange={(e) => handleProjectChange(e.target.value)}
          >
            <option value="">All Projects</option>
            {user.projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectName}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-2 py-1">
        {navItems.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'flex items-center gap-2.5 rounded px-2.5 py-1.5 text-[13px] font-medium transition-colors',
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
          );
        })}
      </nav>

      {/* Footer */}
      <div className="space-y-2 border-t border-surface-0/50 px-3 py-3">
        <ConnectionIndicator connected={connected} />
        <div className="flex items-center justify-between">
          <span className="max-w-[130px] truncate text-xs text-muted-foreground">
            {user?.email}
          </span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => logout()}
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
