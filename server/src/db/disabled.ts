import { type DatabaseAdapter, type DatabaseColumn } from './adapter';

export class DisabledDatabase implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;

  columns(_tableName: string): DatabaseColumn[] {
    return this.unavailable();
  }

  run(_sql: string): void {
    this.unavailable();
  }

  query<T extends object>(_sql: string): T[] {
    return this.unavailable();
  }

  private unavailable(): never {
    throw new Error('synchronous database fallback is disabled');
  }
}
