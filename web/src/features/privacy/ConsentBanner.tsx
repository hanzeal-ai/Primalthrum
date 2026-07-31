import { BarChart3, Check, Loader2, Settings2, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../components/ui/button'

interface ConsentBannerProps {
  decided: boolean
  error: string
  initialAnalytics: boolean
  onClosePreferences: () => void
  onOpenPreferences: () => void
  onSave: (analytics: boolean, source: 'banner' | 'preferences') => void
  preferencesOpen: boolean
  ready: boolean
  saving: boolean
}

export function ConsentBanner(props: ConsentBannerProps) {
  if (!props.ready) return null
  return (
    <>
      {!props.decided ? (
        <aside aria-label="隐私设置" className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-white p-4 shadow-[0_-12px_32px_rgba(0,0,0,0.08)]">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 gap-3">
              <BarChart3 className="mt-0.5 size-5 shrink-0 text-blue-700" />
              <p className="text-sm leading-6 text-zinc-600">
                必要存储用于保存登录和隐私选择。只有获得同意后，我们才记录匿名产品分析。
                <a className="ml-1 text-zinc-950 underline underline-offset-4" href="/legal/privacy">隐私说明</a>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button disabled={props.saving} onClick={props.onOpenPreferences} variant="ghost"><Settings2 />管理</Button>
              <Button disabled={props.saving} onClick={() => props.onSave(false, 'banner')} variant="outline">仅必要</Button>
              <Button disabled={props.saving} onClick={() => props.onSave(true, 'banner')}>
                {props.saving ? <Loader2 className="animate-spin" /> : null}全部接受
              </Button>
            </div>
            {props.error ? <p className="text-sm text-red-700" role="alert">{props.error}</p> : null}
          </div>
        </aside>
      ) : null}
      {props.preferencesOpen ? (
        <ConsentPreferencesDialog {...props} />
      ) : null}
    </>
  )
}

function ConsentPreferencesDialog(props: ConsentBannerProps) {
  const [analytics, setAnalytics] = useState(props.initialAnalytics)
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-zinc-950/45 px-4 py-8" role="presentation">
      <section aria-labelledby="privacy-preferences-title" aria-modal="true" className="w-full max-w-lg bg-white p-6 shadow-2xl" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-xl font-semibold" id="privacy-preferences-title">隐私设置</h2><p className="mt-2 text-sm text-zinc-600">你的选择会保存为版本化同意回执。</p></div>
          <Button aria-label="关闭隐私设置" onClick={props.onClosePreferences} size="icon" variant="ghost"><X /></Button>
        </div>
        <div className="mt-6 divide-y divide-zinc-200 border-y border-zinc-200">
          <PreferenceRow checked description="登录、安全和隐私选择所必需。" label="必要功能" locked />
          <PreferenceRow checked={analytics} description="匿名记录页面和注册漏斗，不接收邮箱或业务内容。" label="产品分析" onChange={setAnalytics} />
        </div>
        {props.error ? <p className="mt-4 text-sm text-red-700" role="alert">{props.error}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button disabled={props.saving} onClick={props.onClosePreferences} variant="ghost">取消</Button>
          <Button disabled={props.saving} onClick={() => props.onSave(analytics, 'preferences')}>
            {props.saving ? <Loader2 className="animate-spin" /> : <Check />}保存选择
          </Button>
        </div>
      </section>
    </div>
  )
}

function PreferenceRow(props: {
  checked: boolean
  description: string
  label: string
  locked?: boolean
  onChange?: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 py-5">
      <span className="min-w-0 flex-1"><span className="font-medium">{props.label}</span><span className="mt-1 block text-sm text-zinc-500">{props.description}</span></span>
      <input aria-label={props.label} checked={props.checked} className="size-5 accent-zinc-950" disabled={props.locked} onChange={(event) => props.onChange?.(event.target.checked)} type="checkbox" />
    </label>
  )
}
