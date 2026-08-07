import {
  type CreateStreamEventInput,
  type StreamEventRecord,
} from './streamEventRepository';
import { type Awaitable } from './storeTypes';

export interface StreamEventStore {
  create(input: CreateStreamEventInput): Awaitable<StreamEventRecord>;
  listByRunId(runId: number): Awaitable<StreamEventRecord[]>;
  listByRunIdAfter(runId: number, afterEventId?: number): Awaitable<StreamEventRecord[]>;
}
