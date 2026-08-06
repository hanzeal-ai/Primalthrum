import { request, type APIResponse } from '@playwright/test'
import { resolve } from 'node:path'

import { SqliteDatabase } from '../../server/src/db/sqlite'
import { BillingRepository } from '../../server/src/services/billingRepository'

const API_URL = 'http://127.0.0.1:43100'
const PASSWORD = 'commercial role matrix password'
const ROLES = ['admin', 'developer', 'member', 'billing', 'viewer'] as const

export default async function globalSetup() {
  const api = await request.newContext({ baseURL: API_URL })
  try {
    const setup = await api.post('/api/setup/admin', {
      data: { email: 'owner@role-matrix.test', password: PASSWORD },
    })
    await assertStatus(setup, 201, 'create role-matrix owner')
    const owner = await setup.json() as {
      user: { workspaceId: number }
      session: { token: string }
    }
    const workspaceId = owner.user.workspaceId
    const authorization = { Authorization: `Bearer ${owner.session.token}` }

    const billing = new BillingRepository(new SqliteDatabase(
      resolve(process.cwd(), '..', '.e2e', 'platform.sqlite'),
    ))
    billing.grantEntitlement({
      workspaceId,
      feature: 'seats',
      enabled: true,
      quantityLimit: 10,
      sourceType: 'test',
      sourceRef: 'browser-role-matrix',
    })
    billing.grantEntitlement({
      workspaceId,
      feature: 'retention.controls',
      enabled: true,
      quantityLimit: null,
      sourceType: 'test',
      sourceRef: 'browser-role-matrix',
    })

    for (const role of ROLES) {
      const email = `${role}@role-matrix.test`
      const invitation = await api.post(`/api/workspaces/${workspaceId}/invitations`, {
        headers: authorization,
        data: { email, role },
      })
      await assertStatus(invitation, 201, `invite ${role}`)
      const created = await invitation.json() as { token: string }
      const accepted = await api.post('/api/invitations/accept', {
        data: { token: created.token, password: PASSWORD },
      })
      await assertStatus(accepted, 201, `accept ${role} invitation`)
    }
  } finally {
    await api.dispose()
  }
}

async function assertStatus(response: APIResponse, expected: number, action: string) {
  if (response.status() === expected) return
  throw new Error(`${action} returned ${response.status()}: ${await response.text()}`)
}
