import { describe, expect, it } from 'vitest'

import {
  canManageChangeControl,
  canManageOperators,
  canManageSupport,
  canUseSupport,
  operatorSectionAllowed,
} from './operatorPermissions'
import type { OperatorRole } from './operatorTypes'

describe('operator permission matrix', () => {
  it.each<[OperatorRole, string[]]>([
    ['super_admin', ['customers', 'billing', 'runtime', 'security', 'support', 'operators', 'audit']],
    ['support', ['customers', 'runtime', 'support', 'operators']],
    ['billing', ['billing']],
    ['security', ['customers', 'runtime', 'security', 'support', 'operators', 'audit']],
    ['viewer', []],
  ])('matches control-plane duties for %s', (
    role,
    allowed,
  ) => {
    expect(operatorSectionAllowed(role, 'overview')).toBe(true)
    expect(operatorSectionAllowed(role, 'workspaces')).toBe(true)
    expect(operatorSectionAllowed(role, 'flags')).toBe(true)
    expect(operatorSectionAllowed(role, 'incidents')).toBe(true)
    for (const section of ['customers', 'billing', 'runtime', 'security', 'support', 'operators', 'audit'] as const) {
      expect(operatorSectionAllowed(role, section)).toBe(allowed.includes(section))
    }
    expect(canManageOperators(role)).toBe(role === 'super_admin')
    expect(canManageSupport(role)).toBe(role === 'super_admin' || role === 'security')
    expect(canUseSupport(role)).toBe(role === 'super_admin' || role === 'support')
    expect(canManageChangeControl(role)).toBe(role === 'super_admin' || role === 'security')
  })
})
