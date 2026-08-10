import { type AsyncDatabaseAdapter } from '../../db/asyncAdapter';

export interface TransferColumn {
  name: string;
  targetType: string;
  primaryKeyPosition: number;
  identity: boolean;
}

export interface TransferTable {
  name: string;
  columns: TransferColumn[];
  primaryKey: string[];
  dependencies: string[];
}

export interface DatabaseTransferCatalog {
  migrationIds: string[];
  tables: TransferTable[];
}

export interface DatabaseTransferOptions {
  source: AsyncDatabaseAdapter;
  target: AsyncDatabaseAdapter;
  catalog: DatabaseTransferCatalog;
  batchSize?: number;
  now?: () => Date;
}

export interface TableTransferReport {
  table: string;
  rows: number;
  digest: string;
}

export interface DatabaseTransferReport {
  status: 'succeeded';
  sourceDialect: 'sqlite';
  targetDialect: 'postgres';
  migrationIds: string[];
  startedAt: string;
  completedAt: string;
  totalRows: number;
  digestAlgorithm: 'sha256';
  tables: TableTransferReport[];
}
