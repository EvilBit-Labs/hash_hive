import { Layers, ListChecks, Server, Trophy } from 'lucide-react'
import { MotionConfig } from 'motion/react'
import { useNavigate } from 'react-router'

import { ConnectionIndicator } from '../components/features/connection-indicator'
import { CrackRateTrendChart } from '../components/features/crack-rate-chart'
import { useEventsConnection } from '../components/features/events-provider'
import { NoAgentsOnboarding } from '../components/features/no-agents-onboarding'
import { StatCard } from '../components/features/stat-card'
import { SystemHealthCard } from '../components/features/system-health-card'
import { EmptyState } from '../components/ui/empty-state'
import { PageHeader } from '../components/ui/page-header'
import { useDashboardStats } from '../hooks/use-dashboard'
import { useDashboardShortcuts } from '../hooks/use-dashboard-shortcuts'
import { useRelativeTime } from '../hooks/use-relative-time'
import { useSparkHistory } from '../hooks/use-spark-history'
import { cn } from '../lib/utils'
import { useUiStore } from '../stores/ui'

const KBD_BASE_CLASS =
  'border-surface-1 bg-surface-0/80 text-foreground/85 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border px-1 font-mono text-[10px] font-medium leading-none'

function focusProjectPicker() {
  // Two `Select` mounts with the same `aria-label="Select project"` can
  // coexist (desktop sidebar + mobile drawer rendered together but
  // visually gated by Tailwind). Prefer the first one that is currently
  // focusable: `:not([disabled]):not([hidden])` is enough because the
  // mobile drawer hides its column with `display: none`, which removes
  // the inner select from the tab order.
  const candidates = document.querySelectorAll<HTMLSelectElement>(
    '[aria-label="Select project"]:not([disabled]):not([hidden])'
  )
  for (const el of candidates) {
    if (el.offsetParent !== null) {
      el.focus()
      return
    }
  }
  // Last-resort fallback: focus whatever's in the DOM and let the
  // browser decide whether to scroll it into view.
  candidates[0]?.focus()
}

export function DashboardPage() {
  const navigate = useNavigate()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const { data: stats, isLoading, dataUpdatedAt, isFetching, refetch } = useDashboardStats()
  const conn = useEventsConnection()

  // Ring-buffer keys carry the project id so switching projects clears the
  // sparkline state cleanly. Hooks must run before the early return below,
  // but when no project is selected we pass `undefined` so the hook
  // short-circuits its append guard rather than silently accumulating
  // samples behind the empty state under a phantom `none:*` key.
  const projectKey = selectedProjectId ?? 'none'
  const agentsValue = selectedProjectId ? stats?.agents.online : undefined
  const campaignsValue = selectedProjectId ? stats?.campaigns.running : undefined
  const tasksValue = selectedProjectId ? stats?.tasks.running : undefined
  const crackedValue = selectedProjectId ? stats?.cracked.total : undefined
  const agentsSpark = useSparkHistory(`${projectKey}:agents`, agentsValue)
  const campaignsSpark = useSparkHistory(`${projectKey}:campaigns`, campaignsValue)
  const tasksSpark = useSparkHistory(`${projectKey}:tasks`, tasksValue)
  const crackedSpark = useSparkHistory(`${projectKey}:cracked`, crackedValue, 60)

  // Freshness signal — surfaced ONLY when the live connection is not
  // open. On `open`, the ConnectionIndicator already says "Live" and
  // events stream in; a counter ticking up to 60s and resetting (on
  // the safety-net poll) would contradict "Live" and read as
  // staleness when there is none. On `fallback` / `error` / the
  // reconnecting transients, the counter is the operator's answer to
  // "how stale is what I'm reading?" — that's when it earns its place.
  // `dataUpdatedAt` is React Query's wall-clock-ms timestamp of the
  // most recent successful fetch; 0 before the first resolve.
  const lastUpdatedLabel = useRelativeTime(dataUpdatedAt || null)
  const isConnectionStale = conn.status === 'fallback' || conn.status === 'error'
  const showFreshnessLine = conn.status !== 'open' && !isLoading

  // First-run gate. The dashboard's wall-of-zeros cold load is a
  // designed surface, not a content vacuum: with no agents ever
  // registered to the project, the four cards would all show 0 /
  // empty / no-trend, which is information-free and reads as
  // "broken" rather than "fresh". Swap to a real onboarding hero
  // until the first agent registration lands. We key on `total`
  // (not `online`) so an operator with a registered-but-offline
  // agent stays on the live dashboard and sees the offline state.
  const showOnboarding = !isLoading && stats?.agents.total === 0

  useDashboardShortcuts({
    onRefresh: () => {
      void refetch()
    },
    onNavigate: (slot) => {
      // Tasks (slot 3) live under campaigns; the Tasks card itself
      // routes to /campaigns, so the keyboard shortcut mirrors that.
      const path = slot === 1 ? '/agents' : slot === 4 ? '/results' : '/campaigns'
      void navigate(path)
    },
    onProjectPicker: () => {
      // Open the mobile drawer first so its picker becomes focusable on
      // small viewports. On desktop this is a no-op (the desktop
      // sidebar is always mounted) and the focus call lands on the
      // visible desktop select.
      setMobileSidebar(true)
      requestAnimationFrame(focusProjectPicker)
    },
  })

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Dashboard</PageHeader>
        <EmptyState message="Select a project to view its dashboard." />
      </div>
    )
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-6">
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-4">
            <PageHeader>Dashboard</PageHeader>
            <div className="flex items-center gap-4">
              {/* Keyboard hints. Decorative — the shortcuts work whether
                  or not the hints are visible. Hidden under md so the
                  mobile header stays compact (no keyboard, no need). */}
              <ul
                className="text-muted-foreground hidden items-center gap-3 text-xs md:flex"
                aria-hidden="true"
              >
                <li className="flex items-center gap-1.5">
                  <kbd className={KBD_BASE_CLASS}>R</kbd>
                  <span>refresh</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <kbd className={cn(KBD_BASE_CLASS, 'px-1.5')}>1-4</kbd>
                  <span>jump</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <kbd className={KBD_BASE_CLASS}>
                    <span aria-hidden="true">⇧</span>P
                  </kbd>
                  <span>project</span>
                </li>
              </ul>
              <ConnectionIndicator />
            </div>
          </div>

          {/* Freshness line — rendered only when the connection is
              degraded. On a live connection the ConnectionIndicator's
              "Live" carries the freshness signal; a counter here
              would contradict it. */}
          {showFreshnessLine && (
            <p
              data-testid="dashboard-last-updated"
              className={cn(
                'text-xs transition-colors',
                isConnectionStale ? 'text-muted-foreground/50' : 'text-muted-foreground'
              )}
            >
              <span>Last updated {lastUpdatedLabel}</span>
              {isFetching && <span className="text-muted-foreground/70 ml-2">refreshing...</span>}
            </p>
          )}
        </div>

        {showOnboarding ? (
          <NoAgentsOnboarding serverOrigin={window.location.origin} />
        ) : (
          <>
            {/*
              Cracked + crack-rate trend form one editorial block on row 1:
              "here is the number, here is its recent shape" rather than the
              generic 4-card-grid-plus-trend layout. Per-card aria-live
              regions on the value slot are scoped inside each StatCard,
              so wrapping this grid in another aria-live would just nest
              polite regions; intentionally omitted.

              Fallback values are `'?'` rather than `0` or empty string so
              a failed stats query does not silently render a real-looking
              metric. Agents uses a whole-object guard (`stats ? ... : '?'`)
              because it renders a composite `online / total` string; the
              other three use field-level `?? '?'`.
            */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:gap-4">
              <StatCard
                title="Cracked"
                value={stats?.cracked.total ?? '?'}
                subtitle="in this project"
                loading={isLoading}
                to="/results"
                accent="--ctp-peach"
                sparkData={crackedSpark}
                emphasis="primary"
                icon={Trophy}
                className="lg:col-span-5"
                celebrateOnIncrement
              />
              <CrackRateTrendChart
                data={crackedSpark}
                loading={isLoading}
                className="lg:col-span-7"
              />
            </div>

            {/*
          Surveillance strip: three supporting metrics in a thin
          equal-width row. Calmer than the hero block above; per-domain
          colors live in the sparkline strokes only, not as card chrome.
        */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <StatCard
                title="Agents"
                value={stats ? `${stats.agents.online} / ${stats.agents.total}` : '?'}
                subtitle="online of registered"
                loading={isLoading}
                to="/agents"
                accent="--ctp-teal"
                sparkData={agentsSpark}
                icon={Server}
              />
              <StatCard
                title="Campaigns"
                value={stats?.campaigns.running ?? '?'}
                subtitle="Running"
                loading={isLoading}
                to="/campaigns"
                accent="--info"
                sparkData={campaignsSpark}
                icon={Layers}
              />
              <StatCard
                title="Tasks"
                value={stats?.tasks.running ?? '?'}
                subtitle="Running"
                loading={isLoading}
                to="/campaigns"
                accent="--ctp-lavender"
                sparkData={tasksSpark}
                icon={ListChecks}
              />
            </div>
          </>
        )}

        <SystemHealthCard />
      </div>
    </MotionConfig>
  )
}
