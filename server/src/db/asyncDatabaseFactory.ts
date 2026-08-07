import { AsyncSqliteDatabase } from './asyncSqlite';
import { createSqliteDatabase } from './databaseFactory';

export function createAsyncSqliteDatabase(databasePath: string): AsyncSqliteDatabase {
  createSqliteDatabase(databasePath);
  return new AsyncSqliteDatabase(databasePath);
}
