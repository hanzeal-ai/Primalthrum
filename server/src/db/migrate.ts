import { runMigrations } from './migrations';
import { SqliteDatabase } from './sqlite';

declare const process: {
  argv: string[];
  cwd: () => string;
  env: Record<string, string | undefined>;
};

const DEFAULT_DB_PATH = `${process.cwd()}/../data/platform.sqlite`;

const dbPath = process.argv[2] ?? process.env.PRIMALTHRUM_DB_PATH ?? DEFAULT_DB_PATH;
const db = new SqliteDatabase(dbPath);

runMigrations(db);

console.log(`Migrations applied to ${dbPath}`);
