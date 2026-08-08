import { type AccountDataExport } from './accountDataExportService';
import { type Awaitable } from './storeTypes';

export interface AccountDataExportStore {
  exportAccount(userId: number): Awaitable<AccountDataExport>;
  exportWorkspace(userId: number, workspaceId: number): Awaitable<AccountDataExport>;
}
