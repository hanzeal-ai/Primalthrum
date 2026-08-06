import { useCallback, useEffect, useState } from 'react'

import {
  changeOperatorPassword,
  clearOperatorToken,
  getOperatorSession,
  getOperatorSetupStatus,
  getStoredOperatorToken,
  loginOperator,
  logoutOperator,
  setupOperator,
} from './operatorClient'
import type { OperatorUser } from './operatorTypes'

export type OperatorSessionMode = 'checking' | 'setup' | 'login' | 'password-change' | 'ready'

export function useOperatorSession() {
  const [mode, setMode] = useState<OperatorSessionMode>('checking')
  const [user, setUser] = useState<OperatorUser | null>(null)
  const [message, setMessage] = useState('')
  const [setupEnabled, setSetupEnabled] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const setup = await getOperatorSetupStatus()
        if (!active) return
        setSetupEnabled(setup.setupEnabled)
        if (setup.needsSetup) {
          setMode('setup')
          return
        }
        if (!getStoredOperatorToken()) {
          setMode('login')
          return
        }
        const session = await getOperatorSession()
        if (!active) return
        setUser(session.user)
        setMode(session.user.mustChangePassword ? 'password-change' : 'ready')
      } catch {
        if (!active) return
        clearOperatorToken()
        setMode('login')
      }
    })()
    return () => { active = false }
  }, [])

  const authenticate = useCallback(async (input: {
    email: string
    password: string
    bootstrapToken?: string
  }) => {
    setMessage('正在验证...')
    try {
      const response = mode === 'setup'
        ? await setupOperator({ ...input, bootstrapToken: input.bootstrapToken ?? '' })
        : await loginOperator(input)
      setUser(response.user)
      setMode(response.user.mustChangePassword ? 'password-change' : 'ready')
      setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '验证失败')
    }
  }, [mode])

  const changePassword = useCallback(async (input: {
    currentPassword: string
    password: string
  }) => {
    setMessage('正在更新密码...')
    try {
      const response = await changeOperatorPassword(input)
      setUser(response.user)
      setMode('ready')
      setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '密码更新失败')
    }
  }, [])

  const logout = useCallback(async () => {
    await logoutOperator()
    setUser(null)
    setMode('login')
  }, [])

  return {
    authenticate,
    changePassword,
    logout,
    message,
    mode,
    setupEnabled,
    user,
  }
}
