import { type DatabaseColumn, type DatabaseDialect } from './adapter';

export type DatabaseParameter = string | number | boolean | Date | Uint8Array | null;

export interface DatabaseStatement {
  text: string;
  values?: readonly DatabaseParameter[];
}

export interface DatabaseCommandResult {
  rowCount: number;
}

export interface AsyncDatabaseSession {
  execute(statement: DatabaseStatement): Promise<DatabaseCommandResult>;
  query<T extends object>(statement: DatabaseStatement): Promise<T[]>;
}

export interface AsyncDatabaseAdapter extends AsyncDatabaseSession {
  readonly dialect: DatabaseDialect;
  columns(tableName: string): Promise<DatabaseColumn[]>;
  transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
