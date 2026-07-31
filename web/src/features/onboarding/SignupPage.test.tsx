import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from '../../api/client'
import { SignupPage } from './SignupPage'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SignupPage', () => {
  it('submits an explicit Pro registration contract', async () => {
    window.history.replaceState({}, '', '/signup?plan=pro')
    vi.spyOn(api, 'getAbuseProtectionConfig').mockResolvedValue({
      provider: 'disabled', siteKey: '', actions: [],
    })
    const onRegister = vi.fn().mockRejectedValue(new Error('test stop'))
    render(<SignupPage message="正在创建工作区..." onRegister={onRegister} />)

    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Acme Agents' } })
    fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: 'owner@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } })
    const button = screen.getByRole('button', { name: '开始 7 天免费试用' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)

    await waitFor(() => expect(onRegister).toHaveBeenCalledWith({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      workspaceName: 'Acme Agents',
      planKey: 'pro',
    }, ''))
    expect((await screen.findByRole('alert')).textContent).toContain('test stop')
  })

  it('blocks incomplete registration before calling the API', async () => {
    window.history.replaceState({}, '', '/signup?plan=free')
    vi.spyOn(api, 'getAbuseProtectionConfig').mockResolvedValue({
      provider: 'disabled', siteKey: '', actions: [],
    })
    const onRegister = vi.fn()
    render(<SignupPage message="" onRegister={onRegister} />)
    const button = screen.getByRole('button', { name: '创建免费工作区' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    expect(onRegister).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('密码至少 12 位')
  })
})
