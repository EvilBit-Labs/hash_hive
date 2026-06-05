import { Layers, ListChecks, Server, Trophy } from 'lucide-react'
import { MotionConfig } from 'motion/react'

import { ConnectionIndicator } from '../components/features/connection-indicator'
import { CrackRateTrendChart } from '../components/features/crack-rate-chart'
import { StatCard } from '../components/features/stat-card'
import { SystemHealthCard } from '../components/features/system-health-card'
import { EmptyState } from '../components/ui/empty-state'
import { PageHeader } from '../components/ui/page-header'
import { useDashboardStats } from '../hooks/use-dashboard'
import { useSparkHistory } from '../hooks/use-spark-history'
import { useUiStore } from '../stores/ui'

export function DashboardPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const { data: stats, isLoading } = useDashboardStats()

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
        <div className="flex items-center justify-between">
          <PageHeader>Dashboard</PageHeader>
          <ConnectionIndicator />
        </div>

        {/*
          Hero composition: Cracked (the operator-moment metric) sits on
          the left of row 1, paired side-by-side with its crack-rate trend
          chart. The two read as one editorial block ("here is the number,
          here is its recent shape") rather than as a four-card grid plus
          a trend below. Cracked spans 5 of 12 columns, the trend spans 7;
          below `lg`, they stack vertically so the pairing still reads on
          tablet/narrow.

          Per-card aria-live regions on the value slot are scoped inside
          each StatCard, so wrapping this grid in another `aria-live`
          would just nest polite regions; intentionally omitted.

          Fallback value `'?'` (not `0` or empty string) is the consistent
          post-load unknown indicator across all four cards: a failed
          stats query does not silently render a real-looking `0`.
        */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:gap-4">
          <StatCard
            title="Cracked"
            value={stats?.cracked.total ?? '?'}
            subtitle="Total hashes"
            loading={isLoading}
            to="/results"
            accent="--ctp-peach"
            sparkData={crackedSpark}
            emphasis="primary"
            icon={Trophy}
            className="lg:col-span-5"
          />
          <CrackRateTrendChart data={crackedSpark} loading={isLoading} className="lg:col-span-7" />
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
            subtitle="Online"
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

        <SystemHealthCard />
      </div>
    </MotionConfig>
  )
}
