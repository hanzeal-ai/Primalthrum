import { type WorkspaceRole } from './workspaceRepository';

export type WorkspacePermission =
  | 'workspace.read'
  | 'workspace.manage'
  | 'members.manage'
  | 'agents.read'
  | 'agents.write'
  | 'agents.run'
  | 'agents.publish'
  | 'providers.manage'
  | 'billing.read'
  | 'billing.manage'
  | 'audit.read';

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set([
    'workspace.read',
    'workspace.manage',
    'members.manage',
    'agents.read',
    'agents.write',
    'agents.run',
    'agents.publish',
    'providers.manage',
    'billing.read',
    'billing.manage',
    'audit.read',
  ]),
  admin: new Set([
    'workspace.read',
    'members.manage',
    'agents.read',
    'agents.write',
    'agents.run',
    'agents.publish',
    'providers.manage',
    'billing.read',
    'audit.read',
  ]),
  developer: new Set([
    'workspace.read',
    'agents.read',
    'agents.write',
    'agents.run',
    'agents.publish',
    'providers.manage',
  ]),
  member: new Set([
    'workspace.read',
    'agents.read',
    'agents.write',
    'agents.run',
  ]),
  billing: new Set([
    'workspace.read',
    'billing.read',
    'billing.manage',
  ]),
  viewer: new Set([
    'workspace.read',
    'agents.read',
    'agents.run',
  ]),
};

export function hasWorkspacePermission(
  role: string,
  permission: WorkspacePermission,
): boolean {
  return role in ROLE_PERMISSIONS
    && ROLE_PERMISSIONS[role as WorkspaceRole].has(permission);
}
