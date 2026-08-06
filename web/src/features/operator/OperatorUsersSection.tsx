import { UserCog } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { createOperator } from './operatorClient'
import {
  formatOperatorDate,
  operatorRoleLabel,
  operatorSelectClassName,
} from './operatorFormatters'
import { canManageOperators } from './operatorPermissions'
import type { OperatorRole, OperatorUser } from './operatorTypes'

export function OperatorUsersSection({
  onReload,
  operators,
  user,
}: {
  onReload: () => Promise<void>
  operators: OperatorUser[]
  user: OperatorUser
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="overflow-hidden rounded-md border bg-white">
        <div className="border-b px-5 py-4"><h2 className="text-sm font-semibold">Operator 账号</h2></div>
        <div className="divide-y">
          {operators.map((operator) => (
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" key={operator.id}>
              <div>
                <p className="text-sm font-medium">{operator.email}</p>
                <p className="mt-1 text-xs text-zinc-500">#{operator.id} · {formatOperatorDate(operator.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{operatorRoleLabel(operator.role)}</Badge>
                {operator.mustChangePassword && <Badge variant="secondary">待改密</Badge>}
                <Badge variant={operator.status === 'active' ? 'success' : 'destructive'}>{operator.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      </section>
      {canManageOperators(user.role) && <OperatorCreateForm onCreated={onReload} />}
    </div>
  )
}

function OperatorCreateForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<OperatorRole>('support')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await createOperator({ email, password, role })
      setEmail('')
      setPassword('')
      await onCreated()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Operator 创建失败')
    }
  }

  return (
    <Card className="h-fit rounded-md">
      <CardHeader><CardTitle className="text-sm">添加 Operator</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Label>邮箱<Input onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></Label>
          <Label>临时密码<Input minLength={16} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></Label>
          <Label>
            角色
            <select className={operatorSelectClassName} onChange={(event) => setRole(event.target.value as OperatorRole)} value={role}>
              {(['support', 'billing', 'security', 'viewer', 'super_admin'] as const).map((item) => (
                <option key={item} value={item}>{operatorRoleLabel(item)}</option>
              ))}
            </select>
          </Label>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <Button type="submit"><UserCog />创建账号</Button>
        </form>
      </CardContent>
    </Card>
  )
}
