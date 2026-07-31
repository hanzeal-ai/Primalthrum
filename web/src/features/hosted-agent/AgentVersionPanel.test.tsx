import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentVersionPanel } from './AgentVersionPanel'

const api = vi.hoisted(() => ({
  createAgentVersion: vi.fn(),
  listAgentDeployments: vi.fn(),
  listAgentVersions: vi.fn(),
  publishAgentVersion: vi.fn(),
  rollbackAgentVersion: vi.fn(),
}))

vi.mock('../../api/client', () => api)

const versions = [
  {
    id: 2,
    workspaceId: 1,
    agentId: 7,
    versionNumber: 2,
    status: 'preview' as const,
    config: {
      memoryProvider: 'sqlite',
      cacheProvider: 'memory',
      ragProvider: 'none',
      enabledTools: [],
      enabledSkills: [],
      modelConfig: {},
      audience: 'workspace' as const,
    },
    sourcePath: '/tmp/agent',
    checksum: 'a'.repeat(64),
    createdByUserId: 1,
    createdAt: '2026-07-31 09:00:00',
    publishedAt: null,
  },
  {
    id: 1,
    workspaceId: 1,
    agentId: 7,
    versionNumber: 1,
    status: 'published' as const,
    config: {
      memoryProvider: 'sqlite',
      cacheProvider: 'memory',
      ragProvider: 'none',
      enabledTools: [],
      enabledSkills: [],
      modelConfig: {},
      audience: 'workspace' as const,
    },
    sourcePath: '/tmp/agent',
    checksum: 'b'.repeat(64),
    createdByUserId: 1,
    createdAt: '2026-07-30 09:00:00',
    publishedAt: '2026-07-30 09:01:00',
  },
]

const deployments = [
  {
    id: 2,
    workspaceId: 1,
    agentId: 7,
    versionId: 2,
    environment: 'preview' as const,
    status: 'active' as const,
    trigger: 'preview' as const,
    urlPath: '/preview/a/test?version=2',
    createdByUserId: 1,
    createdAt: '2026-07-31 09:00:00',
    activatedAt: '2026-07-31 09:00:00',
    deactivatedAt: null,
  },
  {
    id: 1,
    workspaceId: 1,
    agentId: 7,
    versionId: 1,
    environment: 'production' as const,
    status: 'active' as const,
    trigger: 'publish' as const,
    urlPath: '/a/test',
    createdByUserId: 1,
    createdAt: '2026-07-30 09:01:00',
    activatedAt: '2026-07-30 09:01:00',
    deactivatedAt: null,
  },
]

describe('AgentVersionPanel', () => {
  beforeEach(() => {
    api.listAgentVersions.mockResolvedValue(versions)
    api.listAgentDeployments.mockResolvedValue(deployments)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows preview and publish controls to an owner', async () => {
    render(<AgentVersionPanel agentId={7} onClose={() => undefined} role="owner" />)

    expect(await screen.findByRole('heading', { name: '版本 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建预览版本' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开预览' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '发布' })).toBeTruthy()
  })

  it('keeps version history read-only for a viewer', async () => {
    render(<AgentVersionPanel agentId={7} onClose={() => undefined} role="viewer" />)

    expect(await screen.findByRole('heading', { name: '版本 2' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '创建预览版本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发布' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开预览' })).toBeTruthy()
  })
})
