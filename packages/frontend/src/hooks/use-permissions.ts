import { useMemo } from 'react';
import { type PermissionKey, resolvePermissions } from '../lib/permissions';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

export function usePermissions() {
  const user = useAuthStore((s) => s.user);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);

  const currentRoles = useMemo(() => {
    if (!user || !selectedProjectId) return [] as const;
    return user.projects.find((p) => p.projectId === selectedProjectId)?.roles ?? [];
  }, [user, selectedProjectId]);

  const permissions = useMemo(() => resolvePermissions(currentRoles), [currentRoles]);
  const can = useMemo(() => (p: PermissionKey) => permissions.has(p), [permissions]);

  return { can, roles: currentRoles } as const;
}
