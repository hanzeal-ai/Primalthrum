import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'commercial role matrix password'

const ROLE_MATRIX = [
  { role: 'owner', agents: true, billingRead: true, billingManage: true, membersManage: true, settingsManage: true },
  { role: 'admin', agents: true, billingRead: true, billingManage: false, membersManage: true, settingsManage: true },
  { role: 'developer', agents: true, billingRead: false, billingManage: false, membersManage: false, settingsManage: false },
  { role: 'member', agents: true, billingRead: false, billingManage: false, membersManage: false, settingsManage: false },
  { role: 'billing', agents: false, billingRead: true, billingManage: true, membersManage: false, settingsManage: false },
  { role: 'viewer', agents: true, billingRead: false, billingManage: false, membersManage: false, settingsManage: false },
] as const

for (const access of ROLE_MATRIX) {
  test(`@desktop ${access.role} matches the complete Workspace role contract`, async ({ page }) => {
    await login(page, access.role)
    if (access.role === 'billing') {
      await expect(page.getByRole('heading', { name: '账单与套餐' })).toBeVisible()
    }
    const clientErrors = captureClientErrors(page)

    await page.goto('/app/team')
    await expect(page.getByRole('heading', { name: '团队成员' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '成员', exact: true }))
      .toBeVisible({ timeout: 15_000 })
    await expect(page.getByLabel('邀请邮箱')).toHaveCount(access.membersManage ? 1 : 0)
    await expectDesktopNavigation(page, access)
    await expectNoHorizontalOverflow(page)

    await page.goto('/app/settings')
    await expect(page.getByRole('heading', { name: '设置与安全' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '多因素认证' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'API Keys' })).toHaveCount(access.settingsManage ? 1 : 0)
    await expect(page.getByRole('heading', { name: '数据留存' })).toBeVisible()
    if (access.settingsManage) {
      await expect(page.getByLabel('对话记录留存周期')).toBeEnabled()
    } else {
      await expect(page.getByLabel('对话记录留存周期')).toBeDisabled()
    }
    await expectNoHorizontalOverflow(page)

    await page.goto('/app/billing')
    if (access.billingRead) {
      await expect(page.getByRole('heading', { name: '账单与套餐' })).toBeVisible()
      await expect(page.getByText('只有 Workspace Owner 或 Billing 可以管理订阅。'))
        .toHaveCount(access.billingManage ? 0 : 1)
    } else {
      await expect(page.getByRole('heading', { name: '访问受限' })).toBeVisible()
      await expect(page.getByText('你没有账单读取权限')).toBeVisible()
    }
    await expectNoHorizontalOverflow(page)

    await page.goto('/app/usage')
    if (access.billingRead) {
      await expect(page.getByRole('heading', { name: '用量与成本' })).toBeVisible()
      await expect(page.getByRole('button', { name: '保存成本控制' }))
        .toHaveCount(access.billingManage ? 1 : 0)
    } else {
      await expect(page.getByRole('heading', { name: '访问受限' })).toBeVisible()
    }
    await expectNoHorizontalOverflow(page)
    expect(clientErrors).toEqual([])

    expect(await apiStatus(page, '/api/agents')).toBe(access.agents ? 200 : 403)
    expect(await apiStatus(page, '/api/billing/summary')).toBe(access.billingRead ? 200 : 403)
    expect(await apiStatus(page, '/api/workspaces/1/invitations')).toBe(access.membersManage ? 200 : 403)
    expect(await apiStatus(page, '/api/settings/api-keys')).toBe(access.settingsManage ? 200 : 403)
    const retention = await apiJson(page, '/api/settings/retention') as { canManage: boolean }
    expect(retention.canManage).toBe(access.settingsManage)
  })

  test(`@mobile ${access.role} remains usable without overflow`, async ({ page }) => {
    await login(page, access.role)
    const clientErrors = captureClientErrors(page)

    for (const path of ['/app/team', '/app/settings', '/app/billing']) {
      await page.goto(path)
      await expect(page.getByRole('navigation', { name: '移动端 Workspace 导航' })).toBeVisible()
      const mobileNavigation = page.getByRole('navigation', { name: '移动端 Workspace 导航' })
      await expect(mobileNavigation.getByRole('link', { name: '创建 Agent' }))
        .toHaveCount(access.agents ? 1 : 0)
      await expect(mobileNavigation.getByRole('link', { name: '账单' }))
        .toHaveCount(access.billingRead ? 1 : 0)
      await expectNoHorizontalOverflow(page)
    }
    expect(clientErrors).toEqual([])
  })
}

async function login(page: Page, role: typeof ROLE_MATRIX[number]['role']) {
  await page.goto('/login')
  await expect(page.getByText('欢迎回来', { exact: true })).toBeVisible()
  await page.getByLabel('邮箱').fill(`${role}@role-matrix.test`)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('primalthrum.sessionToken')))
    .not.toBeNull()
}

async function expectDesktopNavigation(
  page: Page,
  access: typeof ROLE_MATRIX[number],
) {
  const navigation = page.getByRole('navigation', { name: 'Workspace 导航' })
  await expect(navigation.getByRole('link', { name: '创建 Agent' }))
    .toHaveCount(access.agents ? 1 : 0)
  await expect(navigation.getByRole('link', { name: '账单' }))
    .toHaveCount(access.billingRead ? 1 : 0)
  await expect(navigation.getByRole('link', { name: '用量' }))
    .toHaveCount(access.billingRead ? 1 : 0)
}

async function apiStatus(page: Page, path: string): Promise<number> {
  return page.evaluate(async (apiPath) => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    return fetch(apiPath, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.status)
  }, path)
}

async function apiJson(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (apiPath) => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const response = await fetch(apiPath, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`API ${apiPath} returned ${response.status}`)
    return response.json()
  }, path)
}

function captureClientErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  return errors
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(expect.objectContaining({
    clientWidth: expect.any(Number),
    scrollWidth: expect.any(Number),
  }))
  const overflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))
  expect(overflow).toBeLessThanOrEqual(1)
}
