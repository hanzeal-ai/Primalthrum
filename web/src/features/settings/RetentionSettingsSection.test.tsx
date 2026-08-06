import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RetentionSettingsSection } from './RetentionSettingsSection'

const api = vi.hoisted(() => ({
  enforceRetentionSettings: vi.fn(),
  getRetentionSettings: vi.fn(),
  updateRetentionSettings: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const enabledState = {
  policy: {
    workspaceId: 1,
    conversationDays: 90,
    runDays: 30,
    documentDays: null,
    updatedByUserId: 1,
    lastEnforcedAt: null,
    nextEnforcementAt: '2026-08-01T12:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  preview: { conversations: 4, runs: 9, documents: 0, documentBytes: 0 },
  events: [],
  customRetentionEnabled: true,
  canManage: true,
  legalHoldActive: false,
}

describe('RetentionSettingsSection', () => {
  beforeEach(() => {
    api.getRetentionSettings.mockResolvedValue(enabledState)
    api.updateRetentionSettings.mockResolvedValue(enabledState)
    api.enforceRetentionSettings.mockResolvedValue({
      event: {
        id: 2,
        workspaceId: 1,
        eventType: 'enforcement_completed',
        actorUserId: 1,
        policy: { conversationDays: 90, runDays: 30, documentDays: null },
        result: { conversations: 4, runs: 9, documents: 0 },
        createdAt: '2026-08-01T12:00:00.000Z',
      },
      filesDeleted: 0,
      fileDeletionFailures: 0,
      blockedByLegalHold: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves a custom policy and requires confirmation before immediate cleanup', async () => {
    render(<RetentionSettingsSection workspaceId={1} />)

    expect(await screen.findByRole('heading', { name: '数据留存' })).toBeTruthy()
    expect(await screen.findByText('待清理对话')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('对话记录留存周期'), { target: { value: '180' } })
    fireEvent.change(screen.getByLabelText('运行与事件留存周期'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('留存设置当前密码'), { target: { value: 'current password' } })
    fireEvent.click(screen.getByRole('button', { name: '保存策略' }))

    await waitFor(() => expect(api.updateRetentionSettings).toHaveBeenCalledWith({
      conversationDays: 180,
      runDays: 90,
      documentDays: null,
      password: 'current password',
    }))
    expect(await screen.findByText('留存策略已保存，后台清理已排队。')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('留存设置当前密码'), { target: { value: 'current password' } })
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
    expect(api.enforceRetentionSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认立即清理' }))
    await waitFor(() => expect(api.enforceRetentionSettings).toHaveBeenCalledWith('current password'))
    expect(await screen.findByText(/清理完成：4 个对话/)).toBeTruthy()
  })

  it('shows the plan gate without rendering destructive controls', async () => {
    api.getRetentionSettings.mockResolvedValue({
      ...enabledState,
      customRetentionEnabled: false,
      canManage: true,
    })
    render(<RetentionSettingsSection workspaceId={1} />)

    expect(await screen.findByText('Business 或 Enterprise 套餐可自定义留存周期')).toBeTruthy()
    expect(screen.queryByLabelText('留存设置当前密码')).toBeNull()
    expect(screen.queryByRole('button', { name: '立即执行' })).toBeNull()
  })

  it('shows only a generic preservation notice when cleanup is blocked', async () => {
    api.getRetentionSettings.mockResolvedValue({
      ...enabledState,
      legalHoldActive: true,
    })
    api.enforceRetentionSettings.mockResolvedValue({
      event: {
        id: 3,
        workspaceId: 1,
        eventType: 'enforcement_blocked',
        actorUserId: 1,
        policy: { conversationDays: 90, runDays: 30, documentDays: null },
        result: { legalHoldCount: 1 },
        createdAt: '2026-08-01T12:00:00.000Z',
      },
      filesDeleted: 0,
      fileDeletionFailures: 0,
      blockedByLegalHold: true,
    })
    render(<RetentionSettingsSection workspaceId={1} />)

    expect(await screen.findByText('强制保全策略生效中')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('留存设置当前密码'), { target: { value: 'current password' } })
    fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
    fireEvent.click(screen.getByRole('button', { name: '确认立即清理' }))
    expect(await screen.findByText('强制保全策略生效中，本次数据清理已暂停。')).toBeTruthy()
    expect(screen.queryByText(/LEGAL-/)).toBeNull()
  })
})
