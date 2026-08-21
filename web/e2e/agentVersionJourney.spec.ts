import { expect, test, type Page } from '@playwright/test'

const EMAIL = 'owner@role-matrix.test'
const PASSWORD = 'commercial role matrix password'

test('@desktop owner previews publishes and rolls back an Agent version', async ({ page }) => {
  await login(page)
  const clientErrors = captureClientErrors(page)
  const slug = await createGeneratedAgent(page)

  await page.goto(`/a/${slug}`)
  await expect(page.getByRole('heading', { name: 'Version Journey Agent' })).toBeVisible()
  await page.getByRole('button', { name: '版本与部署' }).click()
  const panel = page.getByRole('dialog', { name: '版本与部署' })
  await expect(panel).toBeVisible()
  const versionOne = panel.getByRole('article').filter({ hasText: '版本 1' })
  await expect(versionOne.getByText('生产环境')).toBeVisible()

  await panel.getByRole('button', { name: '创建预览版本' }).click()
  const versionTwo = panel.getByRole('article').filter({ hasText: '版本 2' })
  await expect(versionTwo.getByText('可预览')).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await versionTwo.getByRole('button', { name: '打开预览' }).click()
  const preview = await popupPromise
  await expect(preview).toHaveURL(new RegExp(`/preview/a/${slug}\\?version=2$`))
  await expect(preview.getByText('预览', { exact: true })).toBeVisible()
  await preview.close()

  await versionTwo.getByRole('button', { name: '发布' }).click()
  await expect(versionTwo.getByText('生产环境')).toBeVisible()
  await expect(versionOne.getByRole('button', { name: '回滚到此版本' })).toBeVisible()

  await versionOne.getByRole('button', { name: '回滚到此版本' }).click()
  await expect(versionOne.getByText('生产环境')).toBeVisible()
  await expect(versionTwo.getByText('生产环境')).toHaveCount(0)
  expect(clientErrors).toEqual([])
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

async function createGeneratedAgent(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const createdResponse = await fetch('/api/agents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Version Journey Agent',
        description: 'Version lifecycle acceptance Agent',
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
    const agent = await createdResponse.json() as { id: number; slug: string }
    const generatedResponse = await fetch(`/api/agents/${agent.id}/generate`, {
      method: 'POST',
      headers,
    })
    if (!generatedResponse.ok) {
      throw new Error(`generate Agent returned ${generatedResponse.status}`)
    }
    return agent.slug
  })
}

function captureClientErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  return errors
}
