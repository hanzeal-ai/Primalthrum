import { expect, test, type Page } from '@playwright/test'

const EMAIL = 'operator@role-matrix.test'
const PASSWORD = 'commercial role matrix password'

test('@desktop operator control plane is ready and operational', async ({ page }) => {
  await loginOperator(page)
  const clientErrors = captureClientErrors(page)

  await expect(page.getByText('系统健康')).toBeVisible()
  await expect(page.getByText('ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Operator 导航' })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('navigation', { name: 'Operator 导航' })
    .getByRole('button', { name: 'Workspaces' }).click()
  await expect(page.getByText('Workspace 运营状态')).toBeVisible()
  await expect(page.getByText('Local Workspace')).toBeVisible()
  await expectNoHorizontalOverflow(page)

  for (const [section, heading] of [
    ['客户', '客户用户'],
    ['计费', '支付事件'],
    ['运行', '后台任务'],
    ['安全', '滥用防护事件'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Operator 导航' })
      .getByRole('button', { name: section }).click()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  }

  await page.getByRole('navigation', { name: 'Operator 导航' })
    .getByRole('button', { name: '功能开关' }).click()
  await page.getByLabel('Key').fill('e2e.operator_flag')
  await page.getByLabel('说明', { exact: true }).fill('Controls the audited Operator browser acceptance rollout.')
  await page.getByRole('button', { name: '创建开关' }).click()
  await expect(page.locator('strong').filter({ hasText: 'e2e.operator_flag' })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('navigation', { name: 'Operator 导航' })
    .getByRole('button', { name: '事故' }).click()
  await page.getByLabel('标题', { exact: true }).fill('Operator browser acceptance incident')
  await page.getByLabel('摘要', { exact: true }).fill('Validates the audited incident lifecycle in the browser gate.')
  await page.getByRole('button', { name: '创建事故' }).click()
  await expect(page.getByText('Operator browser acceptance incident')).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('navigation', { name: 'Operator 导航' })
    .getByRole('button', { name: '支持访问' }).click()
  await expect(page.getByText('创建限时授权')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  expect(clientErrors).toEqual([])
})

test('@mobile operator control plane remains usable without overflow', async ({ page }) => {
  await loginOperator(page)
  const clientErrors = captureClientErrors(page)
  const navigation = page.getByRole('navigation', { name: '移动端 Operator 导航' })
  await expect(navigation).toBeVisible()

  for (const section of ['Workspaces', '客户', '计费', '运行', '安全', '功能开关', '事故', '支持访问', 'Operators', '审计']) {
    await navigation.getByRole('button', { name: section }).click()
    await expectNoHorizontalOverflow(page)
  }
  expect(clientErrors).toEqual([])
})

async function loginOperator(page: Page) {
  await page.goto('/operator')
  await expect(page.getByText('运营人员登录')).toBeVisible()
  await page.getByLabel('邮箱').fill(EMAIL)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('primalthrum.operatorSessionToken')
  ))).not.toBeNull()
  await expect(page.getByText('系统健康')).toBeVisible()
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
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1)
}
