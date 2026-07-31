import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SignupPage } from './SignupPage'

afterEach(cleanup)

describe('SignupPage', () => {
  it('submits an explicit Pro registration contract', async () => {
    window.history.replaceState({}, '', '/signup?plan=pro')
    const onRegister = vi.fn().mockRejectedValue(new Error('test stop'))
    render(<SignupPage message="正在创建工作区..." onRegister={onRegister} />)

    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Acme Agents' } })
    fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: 'owner@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: '开始 7 天免费试用' }))

    await waitFor(() => expect(onRegister).toHaveBeenCalledWith({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      workspaceName: 'Acme Agents',
      planKey: 'pro',
    }))
    expect((await screen.findByRole('alert')).textContent).toContain('test stop')
  })

  it('blocks incomplete registration before calling the API', () => {
    window.history.replaceState({}, '', '/signup?plan=free')
    const onRegister = vi.fn()
    render(<SignupPage message="" onRegister={onRegister} />)
    fireEvent.click(screen.getByRole('button', { name: '创建免费工作区' }))
    expect(onRegister).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('密码至少 12 位')
  })
})
