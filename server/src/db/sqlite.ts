import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { type DatabaseAdapter } from './adapter';

export type SqlValue = string | number | boolean | null;

export class SqliteDatabase implements DatabaseAdapter {
  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
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

export function sqlValue(value: SqlValue): string {
  if (value === null) {
    return 'NULL';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  return `'${value.replace(/'/g, "''")}'`;
}
