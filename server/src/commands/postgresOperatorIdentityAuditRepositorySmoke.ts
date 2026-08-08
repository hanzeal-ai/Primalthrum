import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncOperatorAuditRepository } from '../services/asyncOperatorAuditRepository';
import { AsyncOperatorIdentityRepository } from '../services/asyncOperatorIdentityRepository';
import { hashPassword } from '../services/passwordHash';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  try {
    await runPostgresMigrations(database);
    let now = new Date('2026-08-08T12:00:00.000Z');
    const suffix = Date.now();
    const identities = new AsyncOperatorIdentityRepository(database, () => now);
    const root = await identities.needsSetup()
      ? await identities.createInitial(
          `operator-root-${suffix}@example.com`,
          hashPassword('operator root password one'),
        )
      : await existingBootstrapRoot(database, identities);
    const duplicateRoots = await Promise.allSettled([
      identities.createInitial(
        `operator-root-${suffix}-1@example.com`,
        hashPassword('operator root password one'),
      ),
      identities.createInitial(
        `operator-root-${suffix}-2@example.com`,
        hashPassword('operator root password two'),
      ),
    ]);
    if (
      duplicateRoots.some((result) => result.status === 'fulfilled')
      || await identities.needsSetup()
    ) {
      throw new Error('PostgreSQL operator bootstrap was not one-time');
    }
    const credentials = await identities.findCredentialsByEmail(root.email);
    if (!credentials || credentials.role !== 'super_admin') {
      throw new Error('PostgreSQL root operator credentials are inconsistent');
    }

    const firstSession = await identities.createSession(root.id);
    if ((await identities.findByToken(firstSession.token))?.user.id !== root.id) {
      throw new Error('PostgreSQL operator session was not authenticated');
    }
    now = new Date('2026-08-08T12:01:00.000Z');
    await identities.updatePassword(root.id, hashPassword('rotated operator root password'));
    if (await identities.findByToken(firstSession.token)) {
      throw new Error('PostgreSQL password rotation did not revoke the old operator session');
    }
    const secondSession = await identities.createSession(root.id);
    await identities.revokeToken(secondSession.token);
    if (await identities.findByToken(secondSession.token)) {
      throw new Error('PostgreSQL operator logout did not revoke the session');
    }

    const support = await identities.create({
      email: `operator-support-${suffix}@example.com`,
      passwordHash: hashPassword('temporary support operator password'),
      role: 'support',
    });
    if (!support.mustChangePassword || (await identities.list()).length < 2) {
      throw new Error('PostgreSQL operator provisioning is inconsistent');
    }

    const audits = new AsyncOperatorAuditRepository(database);
    const event = await audits.record({
      operatorUserId: root.id,
      eventType: 'operator.repository_smoke',
      targetType: 'operator',
      targetId: support.id,
      metadata: {
        role: support.role,
        authorization: 'Bearer must-not-persist',
        nested: { password: 'must-not-persist', ticketRef: 'OPS-100' },
      },
    });
    const serialized = JSON.stringify(event.metadata);
    if (
      event.metadata.role !== 'support'
      || serialized.includes('must-not-persist')
      || !serialized.includes('OPS-100')
      || (await audits.list(10))[0]?.eventId !== event.eventId
    ) {
      throw new Error('PostgreSQL operator audit sanitization is inconsistent');
    }
    let immutable = false;
    try {
      await database.execute({
        text: 'UPDATE operator_audit_events SET target_id = $2 WHERE id = $1;',
        values: [event.id, 'mutated'],
      });
    } catch {
      immutable = true;
    }
    if (!immutable) throw new Error('PostgreSQL operator audit evidence was mutable');
    process.stdout.write('postgres operator identity and audit repositories smoke passed\n');
  } finally {
    await database.close();
  }
}

async function existingBootstrapRoot(
  database: PostgresDatabase,
  identities: AsyncOperatorIdentityRepository,
): Promise<{ id: number; email: string }> {
  const rows = await database.query<{ id: number }>({
    text: 'SELECT id FROM operator_users WHERE bootstrap_root = TRUE LIMIT 1;',
  });
  const root = rows[0] ? await identities.findById(Number(rows[0].id)) : null;
  if (!root) throw new Error('PostgreSQL bootstrap root could not be loaded');
  return root;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres operator repository smoke failed'}\n`);
  process.exitCode = 1;
});
