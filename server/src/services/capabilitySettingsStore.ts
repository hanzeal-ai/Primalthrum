import {
  type CapabilityRunSnapshot,
  type CapabilitySettingRecord,
} from './capabilitySettingsRepository';
import { type Awaitable } from './storeTypes';

export interface CapabilitySettingsStore {
  list(workspaceId: number): Awaitable<CapabilitySettingRecord[]>;
  set(
    workspaceId: number,
    capabilityKey: string,
    enabled: boolean,
    updatedByUserId: number,
  ): Awaitable<CapabilitySettingRecord>;
  snapshot(workspaceId: number, selectedKeys: string[]): Awaitable<CapabilityRunSnapshot>;
  assertEnabled(snapshot: CapabilityRunSnapshot): void;
}
