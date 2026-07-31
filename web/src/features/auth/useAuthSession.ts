import { useEffect, useState } from 'react'

import {
  clearStoredSessionToken,
  getCurrentSession,
  getSetupStatus,
  isUnauthorizedError,
  loginAdmin,
  logoutAdmin,
  setupAdmin,
} from '../../api/client'
import type { AuthCredentials, AuthUser } from '../../api/types'

export type AuthMode = 'checking' | 'setup' | 'login' | 'ready'

const DEFAULT_CREDENTIALS: AuthCredentials = {
  email: 'admin@example.com',
  password: '',
}

export function useAuthSession() {
  const [mode, setMode] = useState<AuthMode>('checking')
  const [credentials, setCredentials] = useState<AuthCredentials>(DEFAULT_CREDENTIALS)
  const [message, setMessage] = useState('正在检查登录状态')
  const [user, setUser] = useState<AuthUser | null>(null)

  async function initialize() {
    setMode('checking')
    try {
      const setupStatus = await getSetupStatus()
      if (setupStatus.needsSetup) {
        setMode('setup')
        setMessage('创建第一个管理员账号。')
        return
      }

      const session = await getCurrentSession()
      setUser(session.user)
      setMode('ready')
    } catch (error) {
      clearStoredSessionToken()
      setUser(null)
      setMode('login')
      setMessage(isUnauthorizedError(error) ? '请登录继续。' : errorMessage(error))
    }
  }

  useEffect(() => {
    // Session bootstrap intentionally owns the first auth state transition.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void initialize()
  }, [])

  async function authenticate() {
    const email = credentials.email.trim()
    if (!email || credentials.password.length < 12) {
      setMessage('邮箱必填，密码至少 12 位。')
      return
    }

    setMessage(mode === 'setup' ? '正在创建管理员...' : '正在登录...')
    try {
      const response = mode === 'setup'
        ? await setupAdmin({ email, password: credentials.password })
        : await loginAdmin({ email, password: credentials.password })
      setUser(response.user)
      setMode('ready')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  async function logout() {
    await logoutAdmin()
    setUser(null)
    setMode('login')
    setMessage('已安全退出。')
  }

  return {
    mode,
    credentials,
    message,
    user,
    setCredentials,
    authenticate,
    logout,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '认证失败，请稍后重试。'
}
