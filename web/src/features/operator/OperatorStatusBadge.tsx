import { Badge } from '../../components/ui/badge'

const SUCCESS_STATES = new Set(['active', 'paid', 'published', 'ready', 'completed', 'succeeded'])
const FAILURE_STATES = new Set(['failed', 'past_due', 'suspended', 'rate_limited', 'challenge_failed'])

export function OperatorStatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  const variant = SUCCESS_STATES.has(normalized)
    ? 'success'
    : FAILURE_STATES.has(normalized) ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{status}</Badge>
}
