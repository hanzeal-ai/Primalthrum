import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { type DatabaseAdapter, type DatabaseColumn } from './adapter';

export { sqlValue, type SqlValue } from './sql';

export class SqliteDatabase implements DatabaseAdapter {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  columns(tableName: string): DatabaseColumn[] {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error('database table name is invalid');
    }
    return this.query<DatabaseColumn>(`PRAGMA table_info(${tableName});`);
  }

  run(sql: string): void {
    this.execute(sql);
  }

  query<T extends object>(sql: string): T[] {
    const output = this.execute(`.mode json\n${sql}`);
    if (!output.trim()) {
      return [];
    }
    return JSON.parse(output) as T[];
  }

  private execute(sql: string): string {
    const result = spawnSync('sqlite3', [this.dbPath], {
      input: sql,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || 'sqlite3 command failed');
    }

    return result.stdout;
  }
}
