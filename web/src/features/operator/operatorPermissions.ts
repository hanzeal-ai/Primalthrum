import type { OperatorRole } from './operatorTypes'

export type OperatorSection = 'overview' | 'workspaces' | 'support' | 'operators' | 'audit'

export function operatorSectionAllowed(
  role: OperatorRole,
  section: OperatorSection,
): boolean {
  if (section === 'overview' || section === 'workspaces') return true
  if (section === 'support') return role === 'super_admin' || role === 'support' || role === 'security'
  if (section === 'operators') return role === 'super_admin' || role === 'support' || role === 'security'
  return role === 'super_admin' || role === 'security'
}

export function canManageOperators(role: OperatorRole): boolean {
  return role === 'super_admin'
}

export function canManageSupport(role: OperatorRole): boolean {
  return role === 'super_admin' || role === 'security'
}

export function canUseSupport(role: OperatorRole): boolean {
  return role === 'super_admin' || role === 'support'
}
