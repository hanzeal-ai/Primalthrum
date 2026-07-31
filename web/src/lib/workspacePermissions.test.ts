import { describe, expect, it } from 'vitest'

import type { WorkspaceRole } from '../api/types'
import { canManageBilling, canManageMembers, canReadBilling } from './workspacePermissions'

describe('workspace billing permissions', () => {
  it.each<[WorkspaceRole, boolean, boolean]>([
    ['owner', true, true],
    ['admin', true, false],
    ['developer', false, false],
    ['member', false, false],
    ['billing', true, true],
    ['viewer', false, false],
  ])('mirrors the server role matrix for %s', (role, canRead, canManage) => {
    expect(canReadBilling(role)).toBe(canRead)
    expect(canManageBilling(role)).toBe(canManage)
  })

  it.each<[WorkspaceRole, boolean]>([
    ['owner', true], ['admin', true], ['developer', false],
    ['member', false], ['billing', false], ['viewer', false],
  ])('mirrors member management for %s', (role, expected) => {
    expect(canManageMembers(role)).toBe(expected)
  })
})
