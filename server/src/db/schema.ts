import { runMigrations } from './migrations';
import { type DatabaseAdapter } from './adapter';

export function initializeSchema(db: DatabaseAdapter): void {
  runMigrations(db);
}
