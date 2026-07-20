import { runMigrations } from './migrations';
import { SqliteDatabase } from './sqlite';

export function initializeSchema(db: SqliteDatabase): void {
  runMigrations(db);
}
