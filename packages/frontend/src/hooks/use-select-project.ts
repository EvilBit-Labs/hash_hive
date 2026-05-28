import type { SelectProjectRequest } from '@hashhive/shared'

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

interface MutationCallbacks {
  onError?: (message: string) => void
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/**
 * Set the server-managed active project on the BetterAuth session.
 *
 * Post-#159 the dashboard backend reads scope from `session.projectId`,
 * not from a client header. Every UI surface that changes the active
 * project (login auto-select, the selector page, the sidebar dropdown)
 * must go through this hook so the server, the client cache, and the
 * WebSocket upgrade stay in sync.
 *
 * On success we invalidate the entire query cache: switching projects
 * changes the result of every project-scoped query and enumerating the
 * key set is brittle. The cost is one extra round-trip per active
 * query, which is acceptable on a once-per-session switch event.
 */
export function useSelectProject(callbacks: MutationCallbacks = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (projectId: number) => {
      const body: SelectProjectRequest = { projectId }
      await api.post<unknown>('/dashboard/projects/select', body)
      return { projectId }
    },
    onSuccess: ({ projectId }) => {
      useUiStore.getState().setSelectedProject(projectId)
      void qc.invalidateQueries()
    },
    onError: (err) => {
      callbacks.onError?.(errorMessage(err, 'Failed to select project'))
    },
  })
}
