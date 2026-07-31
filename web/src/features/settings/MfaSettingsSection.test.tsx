import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MfaSettingsSection } from './MfaSettingsSection'

const api = vi.hoisted(() => ({
  beginMfaSetup: vi.fn(),
  confirmMfaSetup: vi.fn(),
  disableMfa: vi.fn(),
  getMfaStatus: vi.fn(),
  regenerateMfaRecoveryCodes: vi.fn(),
}))

vi.mock('../../api/client', () => api)

describe('MfaSettingsSection', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('enrolls an authenticator and displays recovery codes once', async () => {
    api.getMfaStatus.mockResolvedValue({ enabled: false, recoveryCodesRemaining: 0, enabledAt: null })
    api.beginMfaSetup.mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Primalthrum%3Aowner%40example.com',
    })
    api.confirmMfaSetup.mockResolvedValue({
      enabled: true,
      enabledAt: '2026-08-01T10:00:00.000Z',
      recoveryCodesRemaining: 10,
      recoveryCodes: ['AAAAAA-BBBBBB-CCCCCC-DDDDDD', 'EEEEEE-FFFFFF-GGGGGG-HHHHHH'],
    })

    render(<MfaSettingsSection />)
    expect(await screen.findByText('未启用')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('MFA 当前密码'), { target: { value: 'current password value' } })
    fireEvent.click(screen.getByRole('button', { name: '开始设置' }))
    expect(await screen.findByLabelText('MFA 手动密钥')).toHaveProperty('value', 'JBSWY3DPEHPK3PXP')

    fireEvent.change(screen.getByLabelText('MFA 验证码'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '确认启用' }))
    await waitFor(() => expect(api.confirmMfaSetup).toHaveBeenCalledWith('123456'))
    expect(await screen.findByText('AAAAAA-BBBBBB-CCCCCC-DDDDDD')).toBeTruthy()
    expect(screen.getByText('剩余 10 个恢复码', { exact: false })).toBeTruthy()
  })

  it('requires password and a second factor before disabling MFA', async () => {
    api.getMfaStatus.mockResolvedValue({
      enabled: true, recoveryCodesRemaining: 8, enabledAt: '2026-08-01T10:00:00.000Z',
    })
    api.disableMfa.mockResolvedValue(undefined)

    render(<MfaSettingsSection />)
    expect(await screen.findByText('已启用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.change(screen.getByLabelText('MFA 管理密码'), { target: { value: 'current password value' } })
    fireEvent.change(screen.getByLabelText('MFA 管理验证码'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }))

    await waitFor(() => expect(api.disableMfa).toHaveBeenCalledWith({
      password: 'current password value', code: '123456',
    }))
    expect(await screen.findByText('未启用')).toBeTruthy()
  })
})
