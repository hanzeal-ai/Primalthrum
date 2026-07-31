import {
  ArrowLeft,
  Blocks,
  Cpu,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  createProviderConfig,
  listProviderConfigs,
  updateProviderConfig,
} from '../../api/client'
import type { ProviderConfigRecord } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

type ProviderType = 'llm' | 'embedding' | 'stt' | 'tts'

interface ProviderForm {
  name: string
  type: ProviderType
  provider: string
  model: string
  baseUrl: string
  temperature: string
  maxTokens: string
  secret: string
}

interface ProviderSettingsPanelProps {
  onClose: () => void
  onOpenCapabilities: () => void
  onProvidersChange: (providers: ProviderConfigRecord[]) => void
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  type: 'llm',
  provider: 'openai',
  model: '',
  baseUrl: '',
  temperature: '',
  maxTokens: '',
  secret: '',
}

export function ProviderSettingsPanel({
  onClose,
  onOpenCapabilities,
  onProvidersChange,
}: ProviderSettingsPanelProps) {
  const [providers, setProviders] = useState<ProviderConfigRecord[]>([])
  const [editing, setEditing] = useState<ProviderConfigRecord | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [formOpen, setFormOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    setLoading(true)
    try {
      const next = await listProviderConfigs()
      setProviders(next)
      onProvidersChange(next)
    } catch (loadError) {
      setError(errorMessage(loadError, 'Provider 配置加载失败。'))
    } finally {
      setLoading(false)
    }
  }, [onProvidersChange])

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timeout)
  }, [load])

  function startCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError('')
    setFormOpen(true)
  }

  function startEdit(provider: ProviderConfigRecord) {
    setEditing(provider)
    setForm(formFromProvider(provider))
    setError('')
    setFormOpen(true)
  }

  function updateField<Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function changeType(type: ProviderType) {
    setForm((current) => ({
      ...current,
      type,
      provider: 'openai',
      temperature: type === 'llm' ? current.temperature : '',
      maxTokens: type === 'llm' ? current.maxTokens : '',
    }))
  }

  async function save() {
    setError('')
    const validationError = validateForm(form, Boolean(editing?.secretRef))
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    try {
      const input = {
        name: form.name.trim(),
        type: form.type,
        config: providerConfigFromForm(form),
        ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
      }
      if (editing) {
        await updateProviderConfig(editing.id, input)
      } else {
        await createProviderConfig(input)
      }
      setFormOpen(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      await load()
    } catch (saveError) {
      setError(errorMessage(saveError, 'Provider 配置保存失败。'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div aria-label="Provider 设置" className="version-panel-layer" role="dialog">
      <button aria-label="关闭 Provider 设置" className="version-panel-backdrop" onClick={onClose} type="button" />
      <aside className="provider-panel">
        <header className="version-panel-header">
          <div className="flex min-w-0 items-center gap-2">
            {formOpen ? (
              <Button aria-label="返回 Provider 列表" onClick={() => setFormOpen(false)} size="icon" title="返回" variant="ghost">
                <ArrowLeft />
              </Button>
            ) : <Cpu className="size-4 shrink-0" />}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{formOpen ? (editing ? '编辑 Provider' : '添加 Provider') : '模型与语音 Provider'}</h2>
              <p className="mt-1 truncate text-xs text-zinc-500">工作区级模型、语音与密钥配置</p>
            </div>
          </div>
          <div className="flex gap-1">
            {!formOpen ? (
              <>
                <Button aria-label="运行能力" onClick={onOpenCapabilities} size="icon" title="运行能力" variant="ghost"><Blocks /></Button>
                <Button aria-label="刷新 Provider" onClick={() => void load()} size="icon" title="刷新" variant="ghost"><RefreshCcw /></Button>
              </>
            ) : null}
            <Button aria-label="关闭 Provider 设置" onClick={onClose} size="icon" title="关闭" variant="ghost"><X /></Button>
          </div>
        </header>

        <div className="version-panel-content">
          {error ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div> : null}
          {formOpen ? (
            <ProviderFormView
              editing={editing}
              form={form}
              onChange={updateField}
              onChangeType={changeType}
              onSave={() => void save()}
              saving={saving}
            />
          ) : (
            <ProviderList
              loading={loading}
              onCreate={startCreate}
              onEdit={startEdit}
              providers={providers}
            />
          )}
        </div>
      </aside>
    </div>
  )
}

function ProviderList({
  loading,
  onCreate,
  onEdit,
  providers,
}: {
  loading: boolean
  onCreate: () => void
  onEdit: (provider: ProviderConfigRecord) => void
  providers: ProviderConfigRecord[]
}) {
  return (
    <>
      <Button className="self-start" onClick={onCreate} size="sm"><Plus />添加 Provider</Button>
      {loading ? <div className="grid place-items-center py-12"><Loader2 className="size-5 animate-spin" /></div> : null}
      {!loading && !providers.length ? (
        <div className="py-12 text-center">
          <Cpu className="mx-auto size-6 text-zinc-400" />
          <p className="mt-3 text-sm font-medium">还没有模型 Provider</p>
          <p className="mt-1 text-xs text-zinc-500">添加后即可在创建 Agent 时选择</p>
        </div>
      ) : null}
      <div className="grid gap-3">
        {providers.map((provider) => (
          <article className="version-item" key={provider.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{provider.name}</h3>
                  <Badge variant="secondary">{providerTypeLabel(provider.type)}</Badge>
                </div>
                <p className="mt-1 truncate text-xs text-zinc-500">
                  {textConfig(provider, 'provider')} / {textConfig(provider, 'model')}
                </p>
              </div>
              <Button aria-label={`编辑 ${provider.name}`} onClick={() => onEdit(provider)} size="icon" title="编辑" variant="ghost"><Pencil /></Button>
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
              <KeyRound className="size-3.5" />
              {provider.secretRef ? '密钥已配置' : '密钥未配置'}
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

function ProviderFormView({
  editing,
  form,
  onChange,
  onChangeType,
  onSave,
  saving,
}: {
  editing: ProviderConfigRecord | null
  form: ProviderForm
  onChange: <Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) => void
  onChangeType: (type: ProviderType) => void
  onSave: () => void
  saving: boolean
}) {
  const providerOptions = form.type === 'llm'
    ? ['openai', 'openai-compatible', 'anthropic']
    : ['openai', 'openai-compatible']

  return (
    <div className="provider-form">
      <div>
        <span className="text-sm font-medium">能力类型</span>
        <div className="mt-2 grid grid-cols-4 rounded-md border bg-zinc-50 p-1">
          {(['llm', 'embedding', 'stt', 'tts'] as const).map((type) => (
            <button
              className={`provider-segment ${form.type === type ? 'provider-segment-active' : ''}`}
              disabled={Boolean(editing)}
              key={type}
              onClick={() => onChangeType(type)}
              type="button"
            >
              {providerTypeLabel(type)}
            </button>
          ))}
        </div>
      </div>

      <Label>
        配置名称
        <Input autoFocus placeholder="例如：生产 OpenAI" value={form.name} onChange={(event) => onChange('name', event.target.value)} />
      </Label>

      <Label>
        Provider
        <select className="provider-select" value={form.provider} onChange={(event) => onChange('provider', event.target.value)}>
          {providerOptions.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
      </Label>

      <Label>
        模型
        <Input placeholder={providerModelPlaceholder(form.type)} value={form.model} onChange={(event) => onChange('model', event.target.value)} />
      </Label>

      <Label>
        API Base URL（可选）
        <Input inputMode="url" placeholder="留空使用 Provider 默认地址" value={form.baseUrl} onChange={(event) => onChange('baseUrl', event.target.value)} />
      </Label>

      {form.type === 'llm' ? (
        <div className="grid grid-cols-2 gap-3">
          <Label>
            Temperature
            <Input inputMode="decimal" max="2" min="0" placeholder="默认" step="0.1" type="number" value={form.temperature} onChange={(event) => onChange('temperature', event.target.value)} />
          </Label>
          <Label>
            Max tokens
            <Input inputMode="numeric" min="1" placeholder="默认" type="number" value={form.maxTokens} onChange={(event) => onChange('maxTokens', event.target.value)} />
          </Label>
        </div>
      ) : null}

      <Label>
        API Key{editing?.secretRef ? '（留空则保持原密钥）' : ''}
        <Input autoComplete="new-password" placeholder={editing?.secretRef ? '输入新密钥以轮换' : '输入 API Key'} type="password" value={form.secret} onChange={(event) => onChange('secret', event.target.value)} />
      </Label>
      {editing?.secretRef ? (
        <p className="flex items-center gap-2 text-xs text-emerald-700"><KeyRound className="size-3.5" />当前密钥已加密保存，不会回显</p>
      ) : null}

      <Button className="mt-2 w-full" disabled={saving} onClick={onSave}>
        {saving ? <Loader2 className="animate-spin" /> : null}
        {editing ? '保存修改' : '保存 Provider'}
      </Button>
    </div>
  )
}

function formFromProvider(provider: ProviderConfigRecord): ProviderForm {
  const type = isProviderType(provider.type) ? provider.type : 'llm'
  return {
    name: provider.name,
    type,
    provider: textConfig(provider, 'provider') || 'openai',
    model: textConfig(provider, 'model'),
    baseUrl: textConfig(provider, 'baseUrl'),
    temperature: numberConfig(provider, 'temperature'),
    maxTokens: numberConfig(provider, 'maxTokens'),
    secret: '',
  }
}

function isProviderType(value: string): value is ProviderType {
  return ['llm', 'embedding', 'stt', 'tts'].includes(value)
}

function providerTypeLabel(value: string): string {
  return { llm: 'LLM', embedding: 'Embedding', stt: 'STT', tts: 'TTS' }[value] ?? value
}

function providerModelPlaceholder(type: ProviderType): string {
  return {
    llm: '例如：gpt-4.1-mini',
    embedding: '例如：text-embedding-3-small',
    stt: '例如：gpt-4o-mini-transcribe',
    tts: '例如：gpt-4o-mini-tts',
  }[type]
}

function providerConfigFromForm(form: ProviderForm): Record<string, unknown> {
  return {
    provider: form.provider,
    model: form.model.trim(),
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
    ...(form.type === 'llm' && form.temperature !== '' ? { temperature: Number(form.temperature) } : {}),
    ...(form.type === 'llm' && form.maxTokens !== '' ? { maxTokens: Number(form.maxTokens) } : {}),
  }
}

function validateForm(form: ProviderForm, hasSecret: boolean): string {
  if (!form.name.trim()) return '请输入配置名称。'
  if (!form.model.trim()) return '请输入模型名称。'
  if (!hasSecret && !form.secret.trim()) return '请输入 API Key。'
  if (form.baseUrl.trim()) {
    try {
      new URL(form.baseUrl.trim())
    } catch {
      return 'API Base URL 格式不正确。'
    }
  }
  const temperature = form.temperature === '' ? null : Number(form.temperature)
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return 'Temperature 必须在 0 到 2 之间。'
  }
  const maxTokens = form.maxTokens === '' ? null : Number(form.maxTokens)
  if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000)) {
    return 'Max tokens 必须是 1 到 128000 的整数。'
  }
  return ''
}

function textConfig(provider: ProviderConfigRecord, key: string): string {
  const value = provider.config[key]
  return typeof value === 'string' ? value : ''
}

function numberConfig(provider: ProviderConfigRecord, key: string): string {
  const value = provider.config[key]
  return typeof value === 'number' ? String(value) : ''
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
