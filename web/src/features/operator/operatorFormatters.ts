import type { OperatorRole } from './operatorTypes'

export const operatorSelectClassName = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function operatorRoleLabel(role: OperatorRole): string {
  return ({
    super_admin: 'Super Admin',
    support: 'Support',
    billing: 'Billing',
    security: 'Security',
    viewer: 'Viewer',
  })[role]
}

export function formatOperatorDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function formatProviderCost(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value / 1_000_000)
}

export function formatSupportContext(value: unknown): string {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .join(' · ')
  }
  return String(value)
}
