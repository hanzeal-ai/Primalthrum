import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resendVerification, verifyEmail } from '../../api/client'
import { EmailVerificationPage } from './EmailVerificationPage'

vi.mock('../../api/client', () => ({
  resendVerification: vi.fn(),
  verifyEmail: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('EmailVerificationPage', () => {
  it('consumes a verification token once and refreshes the session', async () => {
    window.history.replaceState({}, '', '/verify-email?token=one-time-token')
    vi.mocked(verifyEmail).mockResolvedValue()
    const onVerified = vi.fn().mockResolvedValue(undefined)
    render(<EmailVerificationPage authenticated email="owner@example.com" previewUrl=""
      onLogout={vi.fn()} onPreviewUrl={vi.fn()} onVerified={onVerified} />)

    expect(await screen.findByRole('heading', { name: '邮箱已验证' })).not.toBeNull()
    expect(verifyEmail).toHaveBeenCalledTimes(1)
    expect(verifyEmail).toHaveBeenCalledWith('one-time-token')
    expect(onVerified).toHaveBeenCalledTimes(1)
  })

  it('resends verification and exposes a development preview link', async () => {
    window.history.replaceState({}, '', '/app')
    vi.mocked(resendVerification).mockResolvedValue({ accepted: true, emailPreviewUrl: '/verify-email?token=new' })
    const onPreviewUrl = vi.fn()
    render(<EmailVerificationPage authenticated email="owner@example.com" previewUrl=""
      onLogout={vi.fn()} onPreviewUrl={onPreviewUrl} onVerified={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }))
    await waitFor(() => expect(onPreviewUrl).toHaveBeenCalledWith('/verify-email?token=new'))
    expect(screen.getByText('新的验证邮件已发送，旧链接已失效。')).not.toBeNull()
  })
})
