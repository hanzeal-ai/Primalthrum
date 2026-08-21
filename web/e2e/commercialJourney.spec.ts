import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'commercial journey password'

test('@desktop customer completes trial onboarding and uses a RAG Agent', async ({ page }) => {
  const email = `journey-${Date.now()}@commercial-e2e.test`

  await page.goto('/signup?plan=pro')
  await expect(page.getByRole('heading', { name: '创建你的工作区' })).toBeVisible()
  await page.getByRole('button', { name: '仅必要' }).click()
  await page.waitForLoadState('networkidle')
  const clientErrors = captureClientErrors(page)
  await page.getByLabel('工作区名称').fill('Aster Research')
  await page.getByLabel('工作邮箱').fill(email)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '开始 7 天免费试用' }).click()

  await expect(page.getByRole('heading', { name: '检查你的邮箱' })).toBeVisible()
  const verificationLink = page.getByRole('link', { name: '开发环境：打开验证链接' })
  await expect(verificationLink).toBeVisible()
  await verificationLink.click()
  await expect(page.getByRole('heading', { name: '邮箱已验证' })).toBeVisible()
  await page.getByRole('link', { name: '进入工作台' }).click()

  await expect(page.getByRole('heading', { name: '创建我的 Agent' })).toBeVisible()
  await page.getByRole('textbox', { name: '消息', exact: true })
    .fill('创建一个研究助手，回答 Project Aster 发布问题并引用资料。')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: /Mock Chat/ }).click()
  await page.getByRole('button', { name: /内置 SQLite 向量库/ }).click()
  await page.getByRole('button', { name: /Mock Embedding/ }).click()

  await page.locator('input[type="file"]').setInputFiles({
    name: 'launch.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Project Aster\n\nThe launch date is 2032-06-14.'),
  })
  await expect(page.getByText('资料已加入草稿。确认配置后，我会创建 Agent 并完成索引。'))
    .toBeVisible()
  await page.getByRole('button', { name: '使用资料继续' }).click()
  await page.getByRole('button', { name: '创建 Agent' }).click()
  await expect(page.getByText('独立源码和网页入口已生成，可以直接开始对话。'))
    .toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: '打开 Agent' }).click()
  await expect(page).toHaveURL(/\/a\/[^/?]+$/)
  const hostedAgentUrl = page.url()
  await expect(page.getByText(/你好，我是研究助手/)).toBeVisible()
  await page.getByRole('textbox', { name: '消息', exact: true })
    .fill('What is the Project Aster launch date?')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('mock response: What is the Project Aster launch date?'))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('launch.md', { exact: true })).toBeVisible()

  await page.goto('/app/billing')
  await expect(page.getByRole('heading', { name: '账单与套餐' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pro', level: 2 })).toBeVisible()
  await expect(page.getByText('试用中', { exact: true })).toBeVisible()

  await page.goto('/app/usage')
  await expect(page.getByRole('heading', { name: '用量与成本' })).toBeVisible()
  await expect(page.getByText('RAG 检索', { exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(hostedAgentUrl)
  await expect(page.getByText('launch.md', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  expect(clientErrors).toEqual([])
})

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
