export type DatabaseDialect = 'sqlite' | 'postgres';

export interface DatabaseColumn {
  name: string;
}

export interface DatabaseAdapter {
  readonly dialect: DatabaseDialect;
  columns(tableName: string): DatabaseColumn[];
  run(sql: string): void;
  query<T extends object>(sql: string): T[];
}
