export const OPERATOR_ROLES = [
  'super_admin',
  'support',
  'billing',
  'security',
  'viewer',
] as const;

export type OperatorRole = typeof OPERATOR_ROLES[number];

export type OperatorPermission =
  | 'overview.read'
  | 'workspaces.read'
  | 'customer_users.read'
  | 'billing.read'
  | 'agents.read'
  | 'jobs.read'
  | 'abuse.read'
  | 'feature_flags.read'
  | 'feature_flags.manage'
  | 'incidents.read'
  | 'incidents.manage'
  | 'operators.read'
  | 'operators.manage'
  | 'support.read'
  | 'support.manage'
  | 'support.use'
  | 'audit.read';

export const SUPPORT_GRANT_PERMISSIONS = [
  'workspace.metadata.read',
  'workspace.agents.read',
  'workspace.jobs.read',
  'workspace.billing.read',
] as const;

export type SupportGrantPermission = typeof SUPPORT_GRANT_PERMISSIONS[number];

const ALL_OPERATOR_PERMISSIONS: readonly OperatorPermission[] = [
  'overview.read',
  'workspaces.read',
  'customer_users.read',
  'billing.read',
  'agents.read',
  'jobs.read',
  'abuse.read',
  'feature_flags.read',
  'feature_flags.manage',
  'incidents.read',
  'incidents.manage',
  'operators.read',
  'operators.manage',
  'support.read',
  'support.manage',
  'support.use',
  'audit.read',
];

const ROLE_PERMISSIONS: Record<OperatorRole, ReadonlySet<OperatorPermission>> = {
  super_admin: new Set(ALL_OPERATOR_PERMISSIONS),
  support: new Set([
    'overview.read',
    'workspaces.read',
    'customer_users.read',
    'agents.read',
    'jobs.read',
    'feature_flags.read',
    'incidents.read',
    'operators.read',
    'support.read',
    'support.use',
  ]),
  billing: new Set([
    'overview.read',
    'workspaces.read',
    'billing.read',
    'feature_flags.read',
    'incidents.read',
  ]),
  security: new Set([
    'overview.read',
    'workspaces.read',
    'customer_users.read',
    'agents.read',
    'jobs.read',
    'abuse.read',
    'feature_flags.read',
    'feature_flags.manage',
    'incidents.read',
    'incidents.manage',
    'operators.read',
    'support.read',
    'support.manage',
    'audit.read',
  ]),
  viewer: new Set([
    'overview.read',
    'workspaces.read',
    'feature_flags.read',
    'incidents.read',
  ]),
};

export function hasOperatorPermission(
  role: OperatorRole,
  permission: OperatorPermission,
): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function normalizeOperatorRole(value: unknown): OperatorRole {
  if (typeof value !== 'string' || !OPERATOR_ROLES.includes(value as OperatorRole)) {
    throw new Error('operator role is invalid');
  }
  return value as OperatorRole;
}

export function normalizeSupportGrantPermissions(
  value: unknown,
): SupportGrantPermission[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('at least one support permission is required');
  }
  const normalized = [...new Set(value.map((permission) => {
    if (
      typeof permission !== 'string'
      || !SUPPORT_GRANT_PERMISSIONS.includes(permission as SupportGrantPermission)
    ) {
      throw new Error('support permission is invalid');
    }
    return permission as SupportGrantPermission;
  }))];
  if (!normalized.includes('workspace.metadata.read')) {
    throw new Error('support grants require workspace.metadata.read');
  }
  return normalized;
}
