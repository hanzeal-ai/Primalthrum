import { expect, test, type Page } from '@playwright/test'

const EMAIL = 'owner@role-matrix.test'
const PASSWORD = 'commercial role matrix password'

test('@desktop denied microphone permission preserves hosted Agent text input', async ({ context, page }) => {
  await context.clearPermissions()
  await login(page)
  const pageErrors = capturePageErrors(page)
  const suffix = Date.now().toString(36)
  const agent = await createVoiceAgent(page, suffix, { configureStt: true })
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

test('@desktop hosted Agent accepts browser voice input and reads its response', async ({ page }) => {
  await installBrowserSpeechFakes(page)
  await login(page)
  const pageErrors = capturePageErrors(page)
  const suffix = Date.now().toString(36)
  const agent = await createVoiceAgent(page, suffix, { isolatedWorkspace: true })
  const providerLoaded = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && response.url().endsWith('/api/provider-configs')
      && response.status() === 200
  ))

  await page.goto(`/a/${agent.slug}`)
  await providerLoaded
  await expect(page.getByRole('heading', { name: agent.name })).toBeVisible()
  const composer = page.getByRole('textbox', { name: '消息', exact: true })
  await page.getByRole('button', { name: '开始语音输入' }).click()
  await expect(composer).toHaveValue('Voice interaction is ready.')

  await page.getByRole('button', { name: '发送' }).click()
  const responseText = 'mock response: Voice interaction is ready.'
  await expect(page.getByText(responseText, { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '朗读消息' }).last().click()
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __primalthrumSpokenText?: string }).__primalthrumSpokenText
  ))).toBe(responseText)
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

async function createVoiceAgent(
  page: Page,
  suffix: string,
  options: { configureStt?: boolean; isolatedWorkspace?: boolean },
) {
  return page.evaluate(async ({ configureStt, isolatedWorkspace, uniqueSuffix }) => {
    const token = localStorage.getItem('primalthrum.sessionToken') ?? ''
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    if (isolatedWorkspace) {
      const workspaceResponse = await fetch('/api/workspaces', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: `Voice Interaction ${uniqueSuffix}` }),
      })
      if (!workspaceResponse.ok) {
        throw new Error(`create Workspace returned ${workspaceResponse.status}`)
      }
    }
    if (configureStt) {
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
    }

    const name = `${configureStt ? 'Voice Fallback' : 'Voice Interaction'} Agent ${uniqueSuffix}`
    const createdResponse = await fetch('/api/agents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        description: 'Hosted browser voice acceptance Agent',
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
  }, { ...options, uniqueSuffix: suffix })
}

async function installBrowserSpeechFakes(page: Page) {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      continuous = false
      interimResults = false
      lang = ''
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null = null

      start() {
        queueMicrotask(() => {
          this.onresult?.({
            results: [{ 0: { transcript: 'Voice interaction is ready.' }, isFinal: true }],
          })
          this.onend?.()
        })
      }

      stop() {
        this.onend?.()
      }
    }

    class FakeSpeechSynthesisUtterance {
      lang = ''
      onend: (() => void) | null = null
      onerror: (() => void) | null = null

      constructor(readonly text: string) {}
    }

    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: FakeSpeechRecognition,
    })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel() {},
        speak(utterance: FakeSpeechSynthesisUtterance) {
          ;(window as Window & { __primalthrumSpokenText?: string })
            .__primalthrumSpokenText = utterance.text
          queueMicrotask(() => utterance.onend?.())
        },
      },
    })
  })
}

function capturePageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}
