import type { ReactNode } from 'react';
import { usePermissions } from '../../hooks/use-permissions';
import type { PermissionKey } from '../../lib/permissions';

interface PermissionGuardProps {
  readonly permission: PermissionKey;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}

export function PermissionGuard({ permission, children, fallback = null }: PermissionGuardProps) {
  const { can } = usePermissions();
  if (!can(permission)) return fallback;
  return children;
}
