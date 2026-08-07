import { type PostgresMigration } from '../postgresMigrations';

export const POSTGRES_INVITATION_MIGRATIONS: readonly PostgresMigration[] = [{
  id: '026_workspace_invitation_email',
  up: async (database) => {
    await database.execute({ text: `
      ALTER TABLE account_email_outbox ALTER COLUMN user_id DROP NOT NULL;
      ALTER TABLE account_email_outbox ADD COLUMN IF NOT EXISTS workspace_id INTEGER;
      ALTER TABLE account_email_outbox ADD COLUMN IF NOT EXISTS invitation_id INTEGER;
      ALTER TABLE account_email_outbox DROP CONSTRAINT IF EXISTS account_email_outbox_template_check;
      ALTER TABLE account_email_outbox ADD CONSTRAINT account_email_outbox_template_check
        CHECK(template IN ('verify_email', 'reset_password', 'workspace_invitation'));
      ALTER TABLE account_email_outbox DROP CONSTRAINT IF EXISTS account_email_outbox_target_check;
      ALTER TABLE account_email_outbox ADD CONSTRAINT account_email_outbox_target_check CHECK(
        (template IN ('verify_email', 'reset_password') AND user_id IS NOT NULL)
        OR (template = 'workspace_invitation' AND workspace_id IS NOT NULL AND invitation_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS account_email_outbox_invitation_idx
        ON account_email_outbox(workspace_id, invitation_id, status);
    ` });
  },
}];
