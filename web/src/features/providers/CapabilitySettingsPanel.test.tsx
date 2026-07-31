import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CapabilitySettingsPanel } from './CapabilitySettingsPanel'

const api = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  updateCapabilitySetting: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const fileReader = {
  kind: 'tool',
  name: 'file_reader',
  version: '1.0.0',
  description: 'Read approved files.',
  status: 'available' as const,
  hotPluggable: true,
  configSchema: { type: 'object' },
  permissions: ['fs:read'],
  dependencies: [],
  enabled: true,
}

const plannedSpeech = {
  kind: 'stt',
  name: 'openai',
  version: '1.0.0',
  description: 'Speech to text.',
  status: 'planned' as const,
  hotPluggable: true,
  configSchema: { type: 'object' },
  permissions: [],
  dependencies: [],
  enabled: false,
}

describe('CapabilitySettingsPanel', () => {
  beforeEach(() => {
    api.listCapabilities.mockResolvedValue({
      schemaVersion: '1.0',
      capabilities: [fileReader, plannedSpeech],
      health: [
        { key: 'tool:file_reader', status: 'ok' },
        { key: 'stt:openai', status: 'planned' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('disables an available capability for subsequent runs', async () => {
    api.updateCapabilitySetting.mockResolvedValue({ ...fileReader, enabled: false })
    render(<CapabilitySettingsPanel onBack={vi.fn()} onClose={vi.fn()} />)

    const toggle = await screen.findByRole('switch', { name: '禁用 tool:file_reader' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)

    await waitFor(() => expect(api.updateCapabilitySetting).toHaveBeenCalledWith(
      'tool',
      'file_reader',
      false,
    ))
    expect(await screen.findByRole('switch', { name: '启用 tool:file_reader' })).toBeTruthy()
  })

  it('keeps planned capabilities disabled and read-only', async () => {
    render(<CapabilitySettingsPanel onBack={vi.fn()} onClose={vi.fn()} />)

    const toggle = await screen.findByRole('switch', { name: '启用 stt:openai' })
    expect(toggle).toHaveProperty('disabled', true)
    expect(screen.getByText('Planned')).toBeTruthy()
  })
})
