import { expect, test, type Page } from '@playwright/test'

const EMAIL = 'owner@role-matrix.test'
const PASSWORD = 'commercial role matrix password'

test('@desktop denied microphone permission preserves hosted Agent text input', async ({ context, page }) => {
  await context.clearPermissions()
  await login(page)
  const pageErrors = capturePageErrors(page)
  const suffix = Date.now().toString(36)
  const agent = await createVoiceAgent(page, suffix)
  const providerLoaded = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && response.url().endsWith('/api/provider-configs')
      && response.status() === 200
  ))

  await page.goto(`/a/${agent.slug}`)
  await providerLoaded
  await expect(page.getByRole('heading', { name: agent.name })).toBeVisible()
  const microphone = page.getByRole('button', { name: '开始语音输入' })
  await expect(microphone).toBeEnabled()
  await microphone.click()
  await expect(page.getByText('无法访问麦克风，请检查浏览器权限。', { exact: true }).first())
    .toBeVisible()

  const composer = page.getByRole('textbox', { name: '消息', exact: true })
  await expect(composer).toBeEnabled()
  await composer.fill('Text input still works after microphone denial.')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('mock response: Text input still works after microphone denial.'))
    .toBeVisible({ timeout: 30_000 })
  expect(pageErrors).toEqual([])
})

async function login(page: Page) {
  await page.goto('/login')
  await page.getByRole('button', { name: '仅必要' }).click()
  await page.getByLabel('邮箱').fill(EMAIL)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('primalthrum.sessionToken')
  ))).not.toBeNull()
}

async function createVoiceAgent(page: Page, suffix: string) {
  return page.evaluate(async (uniqueSuffix) => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const providerResponse = await fetch('/api/provider-configs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `voice-fallback-${uniqueSuffix}`,
        type: 'stt',
        config: {
          provider: 'openai-compatible',
          model: 'gpt-4o-mini-transcribe',
          baseUrl: 'https://speech.example/v1',
        },
        secret: `voice-fallback-secret-${uniqueSuffix}`,
      }),
    })
    if (!providerResponse.ok) {
      throw new Error(`create STT Provider returned ${providerResponse.status}`)
    }

    const name = `Voice Fallback Agent ${uniqueSuffix}`
    const createdResponse = await fetch('/api/agents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        description: 'Microphone denial and text fallback acceptance Agent',
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
    const agent = await createdResponse.json() as { id: number; name: string; slug: string }
    const generatedResponse = await fetch(`/api/agents/${agent.id}/generate`, {
      method: 'POST',
      headers,
    })
    if (!generatedResponse.ok) {
      throw new Error(`generate Agent returned ${generatedResponse.status}`)
    }
    return agent
  }, suffix)
}

function capturePageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}
