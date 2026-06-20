import { useState } from 'react'

import { AgentErrorBadge } from '../components/features/agent-error-badge'
import { type AgentFilter, AgentFilterButtons } from '../components/features/agent-filter-buttons'
import { EnrollmentTokenManager } from '../components/features/enrollment-token-manager'
import { PermissionGuard } from '../components/features/permission-guard'
import { StatusBadge } from '../components/features/status-badge'
import { EmptyState } from '../components/ui/empty-state'
import { PageHeader } from '../components/ui/page-header'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import { TextLink } from '../components/ui/text-link'
import { useAgents } from '../hooks/use-dashboard'
import { formatPrimaryEngine, getPrimaryEngine } from '../lib/agent-capabilities'
import { Permission } from '../lib/permissions'
import { cn } from '../lib/utils'
import { useUiStore } from '../stores/ui'

function gpuCount(hardwareProfile: Record<string, unknown> | null | undefined): number | null {
  if (!hardwareProfile) return null
  const gpus = (hardwareProfile as Record<string, unknown>)['gpus']
  if (Array.isArray(gpus)) return gpus.length
  return null
}

function formatCurrentTask(
  task:
    | {
        campaignName: string
        attackMode: number
      }
    | null
    | undefined
): string {
  if (!task) return '-'
  return `${task.campaignName} (mode ${task.attackMode})`
}

export function AgentsPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [statusFilter, setStatusFilter] = useState<AgentFilter>('all')
  const { data, isLoading } = useAgents(
    statusFilter === 'all' ? undefined : { status: statusFilter }
  )

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Agents</PageHeader>
        <EmptyState message="Select a project to view agents." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader>Agents</PageHeader>
        <AgentFilterButtons value={statusFilter} onChange={setStatusFilter} />
      </div>

      <div aria-live="polite">
        {isLoading ? (
          <EmptyState message="Loading agents..." />
        ) : !data?.agents.length ? (
          <NoAgentsState />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Last Seen</Th>
                <Th>Current Task</Th>
                <Th>Hardware</Th>
                <Th>Cracker</Th>
              </tr>
            </TableHead>
            <TableBody>
              {data.agents.map((agent) => {
                const engine = getPrimaryEngine(
                  agent.capabilities as Record<string, unknown> | null | undefined
                )
                const gpus = gpuCount(agent.hardwareProfile)
                const errorCount = agent.errorCount24h ?? 0
                const severity = agent.worstSeverity24h ?? null

                return (
                  <TableRow key={agent.id}>
                    <Td className="text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <TextLink
                          to={`/agents/${agent.id}`}
                          className="text-sm text-foreground hover:text-primary"
                        >
                          {agent.name}
                        </TextLink>
                        <AgentErrorBadge
                          count={errorCount}
                          severity={severity}
                          agentId={agent.id}
                          hashTarget="#errors"
                        />
                      </div>
                    </Td>
                    <Td>
                      <StatusBadge status={agent.status} pulseOnOnline />
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : 'Never'}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {formatCurrentTask(agent.currentTask)}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {gpus === null ? '-' : `${gpus} GPU${gpus === 1 ? '' : 's'}`}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{formatPrimaryEngine(engine)}</Td>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

/**
 * Zero-agents state. Resolves the dashboard "Awaiting first agent" handoff:
 * admins get the enrollment-token mint affordance inline (so "grab a token
 * from the agents page" actually lands somewhere real), while non-admins
 * get honest guidance instead of a button that would 403. On-brand peach
 * register, matching the dashboard hero so the eye lands in the same place.
 */
function NoAgentsState() {
  return (
    <section
      aria-labelledby="agents-empty-title"
      className={cn(
        'relative overflow-hidden rounded-md border p-6 sm:p-8',
        'bg-gradient-to-b from-[hsl(var(--ctp-peach)/0.16)] to-[hsl(var(--ctp-peach)/0.04)]',
        'border-[hsl(var(--ctp-peach)/0.35)]'
      )}
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <h2
            id="agents-empty-title"
            className="text-xl font-semibold tracking-tight text-[hsl(var(--ctp-peach))]"
          >
            No agents yet
          </h2>
          <p className="max-w-prose text-sm text-foreground/80">
            Agents are the workers that actually crack hashes. Register your first one and it'll
            show up here within a few seconds.
          </p>
        </div>
        <PermissionGuard
          permission={Permission.ENROLLMENT_TOKEN_MANAGE}
          fallback={
            <p className="max-w-prose text-sm text-muted-foreground">
              Ask a project admin to generate an enrollment token, then run the agent on your worker
              machine to register it.
            </p>
          }
        >
          <EnrollmentTokenManager serverOrigin={window.location.origin} />
        </PermissionGuard>
      </div>
    </section>
  )
}
