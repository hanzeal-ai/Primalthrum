import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

import { getAbuseProtectionConfig } from '../../api/client'

export interface BotChallengeState {
  ready: boolean
  required: boolean
  token: string
}

export interface BotChallengeHandle {
  reset: () => void
}

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

let configRequest: ReturnType<typeof getAbuseProtectionConfig> | null = null
let scriptRequest: Promise<TurnstileApi> | null = null

export const BotChallenge = forwardRef<BotChallengeHandle, {
  action: 'auth_register' | 'public_agent_stream'
  onChange: (state: BotChallengeState) => void
}>(function BotChallenge({ action, onChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef('')
  const onChangeRef = useRef(onChange)
  const [required, setRequired] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useImperativeHandle(ref, () => ({
    reset: () => {
      const turnstile = turnstileApi()
      if (turnstile && widgetIdRef.current) turnstile.reset(widgetIdRef.current)
      onChangeRef.current({ ready: true, required, token: '' })
    },
  }), [required])

  useEffect(() => {
    let active = true
    let renderedWidgetId = ''
    void abuseConfig().then(async (config) => {
      if (!active) return
      if (config.provider === 'disabled' || !config.actions.includes(action)) {
        onChangeRef.current({ ready: true, required: false, token: '' })
        return
      }
      setRequired(true)
      onChangeRef.current({ ready: false, required: true, token: '' })
      const turnstile = await loadTurnstile()
      if (!active || !containerRef.current) return
      renderedWidgetId = turnstile.render(containerRef.current, {
        sitekey: config.siteKey,
        action,
        theme: 'light',
        size: 'flexible',
        appearance: 'interaction-only',
        retry: 'auto',
        'refresh-expired': 'auto',
        callback: (token: string) => {
          setFailed(false)
          onChangeRef.current({ ready: true, required: true, token })
        },
        'expired-callback': () => onChangeRef.current({ ready: true, required: true, token: '' }),
        'error-callback': () => {
          setFailed(true)
          onChangeRef.current({ ready: false, required: true, token: '' })
        },
      })
      widgetIdRef.current = renderedWidgetId
      onChangeRef.current({ ready: true, required: true, token: '' })
    }).catch(() => {
      if (!active) return
      setRequired(true)
      setFailed(true)
      onChangeRef.current({ ready: false, required: true, token: '' })
    })
    return () => {
      active = false
      const turnstile = turnstileApi()
      if (turnstile && renderedWidgetId) turnstile.remove(renderedWidgetId)
    }
  }, [action])

  if (!required && !failed) return <div className="hidden" ref={containerRef} />
  return (
    <div className="grid gap-2">
      <div aria-label="安全验证" className="min-h-16" ref={containerRef} />
      {failed ? <p className="text-sm text-red-700" role="alert">安全验证加载失败，请刷新后重试。</p> : null}
    </div>
  )
})

function abuseConfig() {
  configRequest ??= getAbuseProtectionConfig()
  return configRequest
}

function loadTurnstile(): Promise<TurnstileApi> {
  const existing = turnstileApi()
  if (existing) return Promise.resolve(existing)
  scriptRequest ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => {
      const loaded = turnstileApi()
      if (loaded) resolve(loaded)
      else reject(new Error('Turnstile API did not load'))
    }
    script.onerror = () => reject(new Error('Turnstile script failed to load'))
    document.head.appendChild(script)
  })
  return scriptRequest
}

function turnstileApi(): TurnstileApi | undefined {
  return (window as typeof window & { turnstile?: TurnstileApi }).turnstile
}
