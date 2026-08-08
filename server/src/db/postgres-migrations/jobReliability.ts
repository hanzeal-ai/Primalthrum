import { type PostgresMigration } from '../postgresMigrations';

export const POSTGRES_JOB_RELIABILITY_MIGRATIONS: readonly PostgresMigration[] = [
  {
    id: '033_job_reliability',
    up: async (database) => {
      await database.execute({
        text: `
          ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
          CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_idx
          ON jobs (workspace_id, type, dedupe_key)
          WHERE dedupe_key IS NOT NULL
            AND status IN ('queued', 'running', 'retrying');
        `,
      });
    },
  },
];
