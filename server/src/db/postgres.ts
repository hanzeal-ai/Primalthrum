import { Pool, type PoolConfig } from 'pg';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
  type DatabaseCommandResult,
  type DatabaseParameter,
  type DatabaseStatement,
} from './asyncAdapter';
import { type DatabaseColumn } from './adapter';

interface QueryResult<T extends object> {
  rows: T[];
  rowCount: number | null;
}

interface PostgresQueryExecutor {
  query<T extends object>(text: string, values?: DatabaseParameter[]): Promise<QueryResult<T>>;
}

interface PostgresPoolClient extends PostgresQueryExecutor {
  release(): void;
}

export interface PostgresPoolFacade extends PostgresQueryExecutor {
  connect(): Promise<PostgresPoolClient>;
  end(): Promise<void>;
}

export type PostgresPoolFactory = (config: PoolConfig) => PostgresPoolFacade;

function statementValues(statement: DatabaseStatement): DatabaseParameter[] | undefined {
  return statement.values ? [...statement.values] : undefined;
}

async function execute(
  executor: PostgresQueryExecutor,
  statement: DatabaseStatement,
): Promise<DatabaseCommandResult> {
  const result = await executor.query(statement.text, statementValues(statement));
  return { rowCount: result.rowCount ?? 0 };
}

async function query<T extends object>(
  executor: PostgresQueryExecutor,
  statement: DatabaseStatement,
): Promise<T[]> {
  const result = await executor.query<T>(statement.text, statementValues(statement));
  return result.rows;
}

function createPool(config: PoolConfig): PostgresPoolFacade {
  const pool = new Pool(config);
  return {
    query: async <T extends object>(text: string, values?: DatabaseParameter[]) => {
      const result = await pool.query(text, values);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async <T extends object>(text: string, values?: DatabaseParameter[]) => {
          const result = await client.query(text, values);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

class PostgresTransactionSession implements AsyncDatabaseSession {
  constructor(private readonly client: PostgresPoolClient) {}

  execute(statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    return execute(this.client, statement);
  }

  query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    return query<T>(this.client, statement);
  }
}

export class PostgresDatabase implements AsyncDatabaseAdapter {
  readonly dialect = 'postgres' as const;
  private readonly pool: PostgresPoolFacade;

  constructor(config: PoolConfig, poolFactory: PostgresPoolFactory = createPool) {
    this.pool = poolFactory(config);
  }

  execute(statement: DatabaseStatement): Promise<DatabaseCommandResult> {
    return execute(this.pool, statement);
  }

  query<T extends object>(statement: DatabaseStatement): Promise<T[]> {
    return query<T>(this.pool, statement);
  }

  columns(tableName: string): Promise<DatabaseColumn[]> {
    return this.query<DatabaseColumn>({
      text: `
        SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
        ORDER BY ordinal_position ASC;
      `,
      values: [tableName],
    });
  }

  async transaction<T>(operation: (session: AsyncDatabaseSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(new PostgresTransactionSession(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the operation or commit error that caused the rollback.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
