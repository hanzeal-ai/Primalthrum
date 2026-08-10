import { spawn } from 'node:child_process';

export interface ProcessInvocation {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type ProcessRunner = (invocation: ProcessInvocation) => Promise<void>;

const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

export function postgresProcessEnvironment(
  connectionString: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('PostgreSQL backup connection string is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('PostgreSQL backup connection string is invalid');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (!database || !user) throw new Error('PostgreSQL backup connection string is incomplete');
  const sslMode = url.searchParams.get('sslmode') ?? undefined;
  if (sslMode && !SSL_MODES.has(sslMode)) {
    throw new Error('PostgreSQL backup sslmode is invalid');
  }
  const { DATABASE_URL: _databaseUrl, ...baseEnvironment } = environment;
  return {
    ...baseEnvironment,
    PGAPPNAME: 'primalthrum-backup',
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: user,
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: '15',
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
  };
}

export const runPostgresProcess: ProcessRunner = ({ binary, args, env }) => new Promise(
  (resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_192);
    });
    child.once('error', () => reject(new Error(`${binary} could not be started`)));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} failed with exit code ${String(code)}: ${stderr.trim()}`));
    });
  },
);
