import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseParameter,
  type DatabaseStatement,
} from './asyncAdapter';
import { type DatabaseColumn } from './adapter';

type SqliteParameter = string | number | bigint | Uint8Array | null;

interface CompiledStatement {
  text: string;
  values: SqliteParameter[];
}

function sqliteParameter(value: DatabaseParameter): SqliteParameter {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

function compileStatement(statement: DatabaseStatement): CompiledStatement {
  const sourceValues = statement.values ?? [];
  const referencedIndexes = new Set<number>();
  const values: SqliteParameter[] = [];
  const text = statement.text.replace(/\$(\d+)/g, (_placeholder, rawIndex: string) => {
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 1 || index > sourceValues.length) {
      throw new Error(`database statement references missing parameter $${rawIndex}`);
    }
    referencedIndexes.add(index);
    values.push(sqliteParameter(sourceValues[index - 1]));
    return '?';
  });

  if (referencedIndexes.size !== sourceValues.length) {
    throw new Error('database statement contains unused parameters');
  }

  return { text, values };
}

class AsyncSqliteSession implements AsyncDatabaseSession {
  constructor(private readonly database: DatabaseSync) {}

  async execute(statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    const compiled = compileStatement(statement);
    const result = this.database.prepare(compiled.text).run(...compiled.values);
    return { rowCount: Number(result.changes) };
  }

  async query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    const compiled = compileStatement(statement);
    const rows = this.database.prepare(compiled.text).all(...compiled.values);
    return rows.map((row) => ({ ...row })) as T[];
  }
}

export class AsyncSqliteDatabase implements AsyncDatabaseAdapter {
  readonly dialect = 'sqlite' as const;
  private readonly database: DatabaseSync;
  private readonly session: AsyncSqliteSession;
  private operationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.session = new AsyncSqliteSession(this.database);
  }

  execute(statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    return this.withConnection(() => this.session.execute(statement));
  }

  query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    return this.withConnection(() => this.session.query<T>(statement));
  }

  columns(tableName: string): Promise<DatabaseColumn[]> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      return Promise.reject(new Error('database table name is invalid'));
    }
    return this.query<DatabaseColumn>({ text: `PRAGMA table_info(${tableName});` });
  }

  transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T> {
    return this.withConnection(async () => {
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        const result = await operation(this.session);
        this.database.exec('COMMIT;');
        return result;
      } catch (error) {
        try {
          this.database.exec('ROLLBACK;');
        } catch {
          // Preserve the operation or commit error that caused the rollback.
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.withConnection(async () => {
      this.database.close();
      this.closed = true;
    });
  }

  private async withConnection<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error('database connection is closed');
    }

    const previousOperation = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousOperation;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
