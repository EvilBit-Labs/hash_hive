export const Permission = {
  CAMPAIGN_CREATE: 'campaign:create',
  CAMPAIGN_EDIT: 'campaign:edit',
  CAMPAIGN_VIEW: 'campaign:view',
  RESOURCE_UPLOAD: 'resource:upload',
  RESOURCE_VIEW: 'resource:view',
  RESULTS_VIEW: 'results:view',
  AGENT_VIEW: 'agent:view',
  PROJECT_SETTINGS: 'project:settings',
  TEMPLATE_VIEW: 'template:view',
  TEMPLATE_MANAGE: 'template:manage',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

const ROLE_PERMISSIONS: Record<string, ReadonlySet<PermissionKey>> = {
  admin: new Set(Object.values(Permission)),
  contributor: new Set([
    Permission.CAMPAIGN_CREATE,
    Permission.CAMPAIGN_EDIT,
    Permission.CAMPAIGN_VIEW,
    Permission.RESOURCE_UPLOAD,
    Permission.RESOURCE_VIEW,
    Permission.RESULTS_VIEW,
    Permission.AGENT_VIEW,
    Permission.TEMPLATE_VIEW,
    Permission.TEMPLATE_MANAGE,
  ]),
  viewer: new Set([
    Permission.CAMPAIGN_VIEW,
    Permission.RESOURCE_VIEW,
    Permission.RESULTS_VIEW,
    Permission.AGENT_VIEW,
    Permission.TEMPLATE_VIEW,
  ]),
};

export function resolvePermissions(roles: readonly string[]): ReadonlySet<PermissionKey> {
  const merged = new Set<PermissionKey>();
  for (const role of roles) {
    const perms = ROLE_PERMISSIONS[role];
    if (perms) {
      for (const p of perms) {
        merged.add(p);
      }
    }
  }
  return merged;
}
