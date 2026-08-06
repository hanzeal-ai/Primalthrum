import { describe, expect, it } from 'vitest'

import {
  canManageOperators,
  canManageSupport,
  canUseSupport,
  operatorSectionAllowed,
} from './operatorPermissions'
import type { OperatorRole } from './operatorTypes'

describe('operator permission matrix', () => {
  it.each<[OperatorRole, boolean, boolean, boolean, boolean]>([
    ['super_admin', true, true, true, true],
    ['support', true, false, true, false],
    ['billing', false, false, false, false],
    ['security', true, true, false, true],
    ['viewer', false, false, false, false],
  ])('matches control-plane duties for %s', (
    role,
    supportVisible,
    supportManage,
    supportUse,
    auditVisible,
  ) => {
    expect(operatorSectionAllowed(role, 'overview')).toBe(true)
    expect(operatorSectionAllowed(role, 'workspaces')).toBe(true)
    expect(operatorSectionAllowed(role, 'support')).toBe(supportVisible)
    expect(operatorSectionAllowed(role, 'audit')).toBe(auditVisible)
    expect(canManageOperators(role)).toBe(role === 'super_admin')
    expect(canManageSupport(role)).toBe(supportManage)
    expect(canUseSupport(role)).toBe(supportUse)
  })
})
