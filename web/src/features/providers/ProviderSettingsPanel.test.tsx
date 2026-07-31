import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderSettingsPanel } from './ProviderSettingsPanel'

const api = vi.hoisted(() => ({
  createProviderConfig: vi.fn(),
  listProviderConfigs: vi.fn(),
  updateProviderConfig: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const configuredProvider = {
  id: 4,
  workspaceId: 1,
  name: 'Production OpenAI',
  type: 'llm',
  config: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    maxTokens: 2048,
  },
  secretRef: 'secret-ref',
}

describe('ProviderSettingsPanel', () => {
  beforeEach(() => {
    api.listProviderConfigs.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a provider and refreshes the builder choices', async () => {
    api.createProviderConfig.mockResolvedValue(configuredProvider)
    api.listProviderConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([configuredProvider])
    const onProvidersChange = vi.fn()
    render(<ProviderSettingsPanel onClose={vi.fn()} onOpenCapabilities={vi.fn()} onProvidersChange={onProvidersChange} />)

    expect(await screen.findByText('还没有模型 Provider')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '添加 Provider' }))
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'Production OpenAI' } })
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-4.1-mini' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Provider' }))

    await waitFor(() => expect(api.createProviderConfig).toHaveBeenCalledWith({
      name: 'Production OpenAI',
      type: 'llm',
      config: { provider: 'openai', model: 'gpt-4.1-mini' },
      secret: 'sk-test',
    }))
    await waitFor(() => expect(onProvidersChange).toHaveBeenLastCalledWith([configuredProvider]))
  })

  it('keeps an existing encrypted secret unless a replacement is entered', async () => {
    api.listProviderConfigs.mockResolvedValue([configuredProvider])
    api.updateProviderConfig.mockResolvedValue(configuredProvider)
    render(<ProviderSettingsPanel onClose={vi.fn()} onOpenCapabilities={vi.fn()} onProvidersChange={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '编辑 Production OpenAI' }))
    expect(screen.getByLabelText('API Key（留空则保持原密钥）')).toHaveProperty('value', '')
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(api.updateProviderConfig).toHaveBeenCalledWith(4, {
      name: 'Production OpenAI',
      type: 'llm',
      config: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        temperature: 0.2,
        maxTokens: 2048,
      },
    }))
  })

  it('creates an STT provider configuration', async () => {
    api.createProviderConfig.mockResolvedValue({
      ...configuredProvider,
      id: 9,
      name: 'Voice Input',
      type: 'stt',
      config: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    })
    render(<ProviderSettingsPanel onClose={vi.fn()} onOpenCapabilities={vi.fn()} onProvidersChange={vi.fn()} />)

    await screen.findByText('还没有模型 Provider')
    fireEvent.click(screen.getByRole('button', { name: '添加 Provider' }))
    fireEvent.click(screen.getByRole('button', { name: 'STT' }))
    fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'Voice Input' } })
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-4o-mini-transcribe' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-voice' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Provider' }))

    await waitFor(() => expect(api.createProviderConfig).toHaveBeenCalledWith({
      name: 'Voice Input',
      type: 'stt',
      config: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
      secret: 'sk-voice',
    }))
  })
})
