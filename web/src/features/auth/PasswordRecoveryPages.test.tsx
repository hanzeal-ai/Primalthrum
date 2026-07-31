import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestPasswordReset, resetPassword } from '../../api/client'
import { ForgotPasswordPage } from './ForgotPasswordPage'
import { ResetPasswordPage } from './ResetPasswordPage'

vi.mock('../../api/client', () => ({
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('password recovery pages', () => {
  it('shows the same accepted state after requesting a reset', async () => {
    vi.mocked(requestPasswordReset).mockResolvedValue({ accepted: true })
    render(<ForgotPasswordPage />)
    fireEvent.change(screen.getByLabelText('账号邮箱'), { target: { value: 'owner@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送重置邮件' }))
    expect(await screen.findByText('如果该邮箱存在且已验证，我们已发送一封密码重置邮件。')).not.toBeNull()
    expect(requestPasswordReset).toHaveBeenCalledWith('owner@example.com')
  })

  it('validates confirmation and completes a one-time reset', async () => {
    window.history.replaceState({}, '', '/reset-password?token=reset-token')
    vi.mocked(resetPassword).mockResolvedValue()
    render(<ResetPasswordPage />)
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new secure password' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'different password' } })
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }))
    expect(screen.getByRole('alert').textContent).toContain('两次密码输入不一致')
    expect(resetPassword).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new secure password' } })
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }))
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith('reset-token', 'new secure password'))
    expect(await screen.findByText('密码已更新，其他设备上的登录状态已失效。')).not.toBeNull()
  })
})
