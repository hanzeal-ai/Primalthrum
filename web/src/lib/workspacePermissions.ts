import type { WorkspaceRole } from '../api/types'

export function canReadBilling(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin' || role === 'billing'
}

export function canManageBilling(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'billing'
}

export function canManageMembers(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin'
}

export function canManageApiKeys(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin'
}
