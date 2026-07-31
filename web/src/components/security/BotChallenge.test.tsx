import { cleanup, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from '../../api/client'
import {
  BotChallenge,
  type BotChallengeHandle,
  type BotChallengeState,
} from './BotChallenge'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as typeof window & { turnstile?: unknown }).turnstile
})

describe('BotChallenge', () => {
  it('binds the Turnstile action, emits a token, and resets consumed state', async () => {
    vi.spyOn(api, 'getAbuseProtectionConfig').mockResolvedValue({
      provider: 'turnstile',
      siteKey: 'site-key',
      actions: ['auth_register', 'public_agent_stream'],
    })
    let options: Record<string, unknown> = {}
    const reset = vi.fn()
    const remove = vi.fn()
    const renderWidget = vi.fn((_container: HTMLElement, value: Record<string, unknown>) => {
      options = value
      return 'widget-1'
    })
    ;(window as typeof window & { turnstile: unknown }).turnstile = {
      render: renderWidget,
      reset,
      remove,
    }
    const onChange = vi.fn<(state: BotChallengeState) => void>()
    const ref = createRef<BotChallengeHandle>()
    const view = render(<BotChallenge action="auth_register" onChange={onChange} ref={ref} />)

    await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1))
    expect(options.sitekey).toBe('site-key')
    expect(options.action).toBe('auth_register')
    ;(options.callback as (token: string) => void)('verified-token')
    expect(onChange).toHaveBeenLastCalledWith({ ready: true, required: true, token: 'verified-token' })

    ref.current?.reset()
    expect(reset).toHaveBeenCalledWith('widget-1')
    expect(onChange).toHaveBeenLastCalledWith({ ready: true, required: true, token: '' })
    view.unmount()
    expect(remove).toHaveBeenCalledWith('widget-1')
  })
})
