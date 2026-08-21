import { expect, test, type Page } from '@playwright/test'

const EMAIL = 'owner@role-matrix.test'
const PASSWORD = 'commercial role matrix password'

interface AgentSummary {
  id: number
  name: string
  slug: string
}

test('@desktop owner cannot access Agents across Workspaces', async ({ page }) => {
  await login(page)
  const pageErrors = capturePageErrors(page)
  const primaryWorkspaceId = await activeWorkspaceId(page)
  const suffix = Date.now().toString(36)
  const primaryAgent = await createGeneratedAgent(page, `Primary Tenant Agent ${suffix}`)

  await expectAgentAvailable(page, primaryAgent)
  await createWorkspaceThroughUi(page, `Isolated Workspace ${suffix}`)
  const isolatedWorkspaceId = await activeWorkspaceId(page)
  expect(isolatedWorkspaceId).not.toBe(primaryWorkspaceId)
  await expect(page.getByLabel('工作区', { exact: true })).toHaveValue(String(isolatedWorkspaceId))

  await expectWorkspaceAgents(page, { includes: [], excludes: [primaryAgent.slug] })
  await expectAgentUnavailable(page, primaryAgent.slug)

  const isolatedAgent = await createGeneratedAgent(page, `Isolated Tenant Agent ${suffix}`)
  await expectAgentAvailable(page, isolatedAgent)

  await page.goto('/app')
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    page.getByLabel('工作区', { exact: true }).selectOption(String(primaryWorkspaceId)),
  ])
  await expect(activeWorkspaceId(page)).resolves.toBe(primaryWorkspaceId)
  await expect(page.getByLabel('工作区', { exact: true })).toHaveValue(String(primaryWorkspaceId))

  await expectWorkspaceAgents(page, {
    includes: [primaryAgent.slug],
    excludes: [isolatedAgent.slug],
  })
  await expectAgentUnavailable(page, isolatedAgent.slug)
  expect(pageErrors).toEqual([])
})

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('邮箱').fill(EMAIL)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('primalthrum.sessionToken')
  ))).not.toBeNull()
}

async function createWorkspaceThroughUi(page: Page, name: string) {
  await page.goto('/app')
  await page.getByRole('button', { name: '新建工作区' }).click()
  await page.getByLabel('工作区名称').fill(name)
  await Promise.all([
    page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
    page.getByRole('button', { name: '创建工作区' }).click(),
  ])
  await expect(page.getByRole('heading', { name: '创建我的 Agent' })).toBeVisible()
}

async function activeWorkspaceId(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const response = await fetch('/api/auth/session', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`session returned ${response.status}`)
    const session = await response.json() as { user: { workspaceId: number } }
    return session.user.workspaceId
  })
}

async function createGeneratedAgent(page: Page, name: string): Promise<AgentSummary> {
  return page.evaluate(async (agentName) => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const createdResponse = await fetch('/api/agents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: agentName,
        description: 'Cross-tenant browser isolation acceptance Agent',
        memoryProvider: 'sqlite',
        cacheProvider: 'sqlite',
        ragProvider: 'none',
        enabledTools: ['file_reader'],
        enabledSkills: ['research'],
      }),
    })
    if (!createdResponse.ok) {
      throw new Error(`create Agent returned ${createdResponse.status}`)
    }
    const agent = await createdResponse.json() as AgentSummary
    const generatedResponse = await fetch(`/api/agents/${agent.id}/generate`, {
      method: 'POST',
      headers,
    })
    if (!generatedResponse.ok) {
      throw new Error(`generate Agent returned ${generatedResponse.status}`)
    }
    return agent
  }, name)
}

async function expectWorkspaceAgents(
  page: Page,
  expected: { includes: string[]; excludes: string[] },
) {
  const slugs = await page.evaluate(async () => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const response = await fetch('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`list Agents returned ${response.status}`)
    const agents = await response.json() as AgentSummary[]
    return agents.map((agent) => agent.slug)
  })
  for (const slug of expected.includes) expect(slugs).toContain(slug)
  for (const slug of expected.excludes) expect(slugs).not.toContain(slug)
}

async function expectAgentAvailable(page: Page, agent: AgentSummary) {
  await page.goto(`/a/${agent.slug}`)
  await expect(page.getByRole('heading', { name: agent.name })).toBeVisible()
}

async function expectAgentUnavailable(page: Page, slug: string) {
  expect(await agentStatus(page, slug)).toBe(404)
  await page.goto(`/a/${slug}`)
  await expect(page.getByRole('heading', { name: 'Agent 无法打开' })).toBeVisible()
}

async function agentStatus(page: Page, slug: string): Promise<number> {
  return page.evaluate(async (agentSlug) => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    return fetch(`/api/agents/slug/${encodeURIComponent(agentSlug)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.status)
  }, slug)
}

function capturePageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}
