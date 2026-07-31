import { useEffect, useState } from 'react'

import {
  clearStoredSessionToken,
  getCurrentSession,
  getSetupStatus,
  isUnauthorizedError,
  loginAdmin,
  logoutAdmin,
  registerAccount,
  setupAdmin,
} from '../../api/client'
import type { AuthCredentials, AuthUser, RegistrationInput } from '../../api/types'

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
  const [emailVerified, setEmailVerified] = useState(false)
  const [emailPreviewUrl, setEmailPreviewUrl] = useState(() => (
    window.sessionStorage.getItem('primalthrum.email-preview-url') ?? ''
  ))

  async function initialize() {
    setMode('checking')
    try {
      const session = await getCurrentSession()
      setUser(session.user)
      setEmailVerified(session.emailVerified)
      setMode('ready')
      return
    } catch (error) {
      clearStoredSessionToken()
      setUser(null)
      setEmailVerified(false)
      try {
        const setupStatus = await getSetupStatus()
        if (setupStatus.needsSetup) {
          setMode('setup')
          setMessage('创建第一个管理员账号。')
          return
        }
      } catch {
        setMode('login')
        setMessage(errorMessage(error))
        return
      }
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
      setEmailVerified(response.emailVerified)
      setMode('ready')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  async function logout() {
    await logoutAdmin()
    setUser(null)
    setEmailVerified(false)
    setMode('login')
    setMessage('已安全退出。')
  }

  async function register(input: RegistrationInput, challengeToken = '') {
    setMessage('正在创建工作区...')
    try {
      const response = await registerAccount(input, challengeToken)
      setUser(response.user)
      setEmailVerified(response.emailVerified)
      const previewUrl = response.emailPreviewUrl ?? ''
      setEmailPreviewUrl(previewUrl)
      if (previewUrl) window.sessionStorage.setItem('primalthrum.email-preview-url', previewUrl)
      setMode('ready')
      return response
    } catch (error) {
      setMessage(errorMessage(error))
      throw error
    }
  }

  async function refreshSession() {
    const session = await getCurrentSession()
    setUser(session.user)
    setEmailVerified(session.emailVerified)
    if (session.emailVerified) {
      setEmailPreviewUrl('')
      window.sessionStorage.removeItem('primalthrum.email-preview-url')
    }
  }

  function updateEmailPreview(url: string) {
    setEmailPreviewUrl(url)
    if (url) window.sessionStorage.setItem('primalthrum.email-preview-url', url)
  }

  return {
    mode,
    credentials,
    message,
    user,
    emailVerified,
    emailPreviewUrl,
    setCredentials,
    authenticate,
    register,
    refreshSession,
    updateEmailPreview,
    logout,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '认证失败，请稍后重试。'
}
