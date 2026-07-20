import { join } from 'node:path';

import { restoreBackup } from '../services/backupService';

declare const process: {
  argv: string[];
  cwd: () => string;
  env: Record<string, string | undefined>;
};

const backupDir = process.argv[2] ?? process.env.BACKUP_DIR;
if (!backupDir) {
  throw new Error('backup directory argument is required');
}

const dbPath = process.env.PRIMALTHRUM_DB_PATH
  ?? join(process.cwd(), '..', 'data', 'platform.sqlite');
const documentStorageDir = process.env.DOCUMENT_STORAGE_DIR
  ?? join(process.cwd(), '..', 'data', 'documents');

const manifest = restoreBackup({
  dbPath,
  documentStorageDir,
  backupDir,
});

console.log(`Backup restored from ${backupDir}`);
console.log(JSON.stringify(manifest));
