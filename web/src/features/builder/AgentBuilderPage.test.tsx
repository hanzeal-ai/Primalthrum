import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentBuilderPage } from './AgentBuilderPage'

vi.mock('../../api/client', () => ({
  createProviderConfig: vi.fn(),
  createAgent: vi.fn(),
  createDocument: vi.fn(),
  generateAgentProject: vi.fn(),
  indexDocument: vi.fn(),
  listProviderConfigs: vi.fn().mockResolvedValue([]),
  listWorkspaces: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: 'Local Workspace',
      slug: 'local',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]),
  updateProviderConfig: vi.fn(),
}))

describe('AgentBuilderPage', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    })
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  it('moves through description, model, RAG, knowledge, and review in one conversation', async () => {
    render(
      <AgentBuilderPage
        onLogout={vi.fn(async () => undefined)}
        user={{ id: 1, workspaceId: 1, email: 'admin@example.com', role: 'admin' }}
      />,
    )

    const input = screen.getByRole('textbox', { name: '消息' })
    fireEvent.change(input, { target: { value: '创建一个研究资料并输出报告的 Agent' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByRole('heading', { name: '选择主要模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Mock Chat/ }))

    expect(await screen.findByRole('heading', { name: '选择知识库方式' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /启用内置向量库/ }))

    expect(await screen.findByRole('heading', { name: '资料' })).toBeTruthy()
    const supplement = screen.getByRole('textbox', { name: '消息' })
    fireEvent.change(supplement, { target: { value: '回答必须包含来源' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('补充要求已记录。你可以继续上传资料，或者进入配置确认。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '暂时跳过' }))
    expect(await screen.findByRole('heading', { name: '确认 Agent 配置' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建 Agent' })).toBeTruthy()
  })
})
