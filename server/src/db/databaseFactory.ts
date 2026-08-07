import { type DatabaseAdapter } from './adapter';
import { initializeSchema } from './schema';
import { SqliteDatabase } from './sqlite';

export function initializeDatabase<T extends DatabaseAdapter>(database: T): T {
  initializeSchema(database);
  return database;
}

export function createSqliteDatabase(databasePath: string): SqliteDatabase {
  return initializeDatabase(new SqliteDatabase(databasePath));
}
