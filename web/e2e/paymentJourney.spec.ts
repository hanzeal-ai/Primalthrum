import { createHmac } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'

import { BROWSER_E2E_WEBHOOK_SECRET } from '../../server/tests/support/browserE2ePaymentAdapter'

const PASSWORD = 'commercial payment password'

test('@desktop customer upgrades from Free after signed payment webhooks', async ({ page }) => {
  const email = `payment-${Date.now()}@commercial-e2e.test`

  await page.goto('/signup?plan=free')
  await expect(page.getByRole('heading', { name: '创建你的工作区' })).toBeVisible()
  await page.getByRole('button', { name: '仅必要' }).click()
  await page.getByLabel('工作区名称').fill('Payment Journey')
  await page.getByLabel('工作邮箱').fill(email)
  await page.getByLabel('密码').fill(PASSWORD)
  await page.getByRole('button', { name: '创建免费工作区' }).click()
  await page.getByRole('link', { name: '开发环境：打开验证链接' }).click()
  await expect(page.getByRole('heading', { name: '邮箱已验证' })).toBeVisible()
  await page.getByRole('link', { name: '进入工作台' }).click()

  const workspaceId = await currentWorkspaceId(page)
  await page.goto('/app/billing')
  await expect(page.getByRole('heading', { name: 'Free', level: 2 })).toBeVisible()
  await page.getByRole('button', { name: '升级到 Pro' }).click()
  await expect(page).toHaveURL(/\/app\/billing\?checkout=success&session_id=cs_e2e_/)

  const now = Math.floor(Date.now() / 1000)
  await sendWebhook(page, webhookEvent(
    `evt_e2e_subscription_${workspaceId}`,
    'customer.subscription.updated',
    now,
    {
      id: `sub_e2e_${workspaceId}`,
      customer: `cus_e2e_${workspaceId}`,
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: now,
      current_period_end: now + 2_592_000,
      metadata: { workspace_id: String(workspaceId), plan_key: 'pro' },
      items: { data: [{ id: `si_e2e_${workspaceId}`, price: { id: 'price_pro' } }] },
    },
  ))
  const invoiceRef = `in_e2e_${workspaceId}`
  await sendWebhook(page, webhookEvent(
    `evt_e2e_invoice_${workspaceId}`,
    'invoice.paid',
    now + 1,
    {
      id: invoiceRef,
      customer: `cus_e2e_${workspaceId}`,
      subscription: `sub_e2e_${workspaceId}`,
      status: 'paid',
      paid: true,
      amount_due: 2900,
      amount_paid: 2900,
      currency: 'usd',
      period_start: now,
      period_end: now + 2_592_000,
    },
  ))

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Pro', level: 2 })).toBeVisible()
  await expect(page.getByText('正常', { exact: true })).toBeVisible()
  await expect(page.getByText(invoiceRef, { exact: true })).toBeVisible()
})

async function currentWorkspaceId(page: Page): Promise<number> {
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

async function sendWebhook(page: Page, event: Record<string, unknown>) {
  const rawBody = JSON.stringify(event)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', BROWSER_E2E_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  const response = await page.request.post('http://127.0.0.1:43100/api/webhooks/stripe', {
    data: rawBody,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    },
  })
  expect(response.status()).toBe(200)
}

function webhookEvent(
  id: string,
  type: string,
  created: number,
  object: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    type,
    created,
    livemode: false,
    api_version: '2025-06-30.basil',
    data: { object },
  }
}
