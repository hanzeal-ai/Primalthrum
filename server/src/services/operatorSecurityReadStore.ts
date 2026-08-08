import { type OperatorAbuseEventSummary } from './operatorSecurityReadRepository';
import { type Awaitable } from './storeTypes';

export interface OperatorSecurityReadStore {
  listAbuseEvents(limit?: number): Awaitable<OperatorAbuseEventSummary[]>;
}
