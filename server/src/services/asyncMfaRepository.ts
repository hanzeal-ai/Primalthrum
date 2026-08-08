import { randomBytes } from 'node:crypto';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import {
  databaseTimestamp,
  nullableDatabaseTimestamp,
} from '../db/databaseTimestamp';
import { AsyncSecretVault } from './asyncSecretVault';
import {
  type MfaChallenge,
  type MfaChallengePurpose,
  type MfaFactor,
  type MfaStatus,
  type MfaStore,
} from './mfaStore';
import { hashToken } from './sessionRepository';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

interface FactorRow {
  user_id: number;
  secret_workspace_id: number;
  secret_ref: string;
  state: 'pending' | 'enabled';
  last_used_step: number;
  enabled_at: string | Date | null;
}

interface ChallengeRow {
  id: number;
  user_id: number;
  purpose: MfaChallengePurpose;
  context_json: string;
  attempts: number;
  expires_at: string | Date;
}

const FACTOR_COLUMNS = [
  'user_id', 'secret_workspace_id', 'secret_ref', 'state',
  'last_used_step', 'enabled_at',
].join(', ');

export class AsyncMfaRepository implements MfaStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly secrets: AsyncSecretVault,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(userId: number): Promise<MfaStatus> {
    const [factor, counts] = await Promise.all([
      this.factor(userId),
      this.database.query<{ count: number | string }>({
        text: `
          SELECT COUNT(*) AS count FROM user_mfa_recovery_codes
          WHERE user_id = $1 AND used_at IS NULL;
        `,
        values: [userId],
      }),
    ]);
    return {
      enabled: factor?.state === 'enabled',
      recoveryCodesRemaining: Number(counts[0]?.count ?? 0),
      enabledAt: factor?.enabledAt ?? null,
    };
  }

  async factor(userId: number): Promise<MfaFactor | null> {
    const rows = await this.database.query<FactorRow>({
      text: `SELECT ${FACTOR_COLUMNS} FROM user_mfa_factors WHERE user_id = $1 LIMIT 1;`,
      values: [userId],
    });
    return rows[0] ? toFactor(rows[0]) : null;
  }

  secret(factor: MfaFactor): Promise<string> {
    return this.secrets.read(factor.secretRef, factor.secretWorkspaceId);
  }

  beginSetup(userId: number, secretWorkspaceId: number, secret: string): Promise<void> {
    return this.database.transaction(async (session) => {
      const existingRows = await session.query<FactorRow>({
        text: `SELECT ${FACTOR_COLUMNS} FROM user_mfa_factors WHERE user_id = $1 LIMIT 1;`,
        values: [userId],
      });
      const existing = existingRows[0];
      if (existing?.state === 'enabled') throw new Error('MFA is already enabled');
      const secretRef = await this.secrets.createInSession(session, secret, secretWorkspaceId);
      await session.execute({
        text: `
          INSERT INTO user_mfa_factors (
            user_id, secret_workspace_id, secret_ref, state, last_used_step
          ) VALUES ($1, $2, $3, 'pending', -1)
          ON CONFLICT(user_id) DO UPDATE SET
            secret_workspace_id = excluded.secret_workspace_id,
            secret_ref = excluded.secret_ref,
            state = 'pending',
            last_used_step = -1,
            enabled_at = NULL,
            updated_at = CURRENT_TIMESTAMP;
        `,
        values: [userId, secretWorkspaceId, secretRef],
      });
      if (existing) {
        await session.execute({
          text: 'DELETE FROM secrets WHERE secret_ref = $1 AND workspace_id = $2;',
          values: [existing.secret_ref, existing.secret_workspace_id],
        });
      }
      await recordEvent(session, userId, 'setup_started');
    });
  }

  enable(userId: number, usedStep: number, recoveryCodeHashes: string[]): Promise<void> {
    assertRecoveryCodeHashes(recoveryCodeHashes);
    return this.database.transaction(async (session) => {
      const updated = await session.execute({
        text: `
          UPDATE user_mfa_factors SET state = 'enabled', last_used_step = $2,
            enabled_at = $3, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND state = 'pending';
        `,
        values: [userId, usedStep, this.now().toISOString()],
      });
      if (updated.rowCount !== 1) throw new Error('MFA setup has not been started');
      await replaceRecoveryCodeRows(session, userId, recoveryCodeHashes);
      await recordEvent(session, userId, 'enabled');
    });
  }

  replaceRecoveryCodes(userId: number, recoveryCodeHashes: string[]): Promise<void> {
    assertRecoveryCodeHashes(recoveryCodeHashes);
    return this.database.transaction(async (session) => {
      await replaceRecoveryCodeRows(session, userId, recoveryCodeHashes);
      await recordEvent(session, userId, 'recovery_codes_regenerated');
    });
  }

  async claimTotpStep(userId: number, step: number): Promise<boolean> {
    const rows = await this.database.query<{ user_id: number }>({
      text: `
        UPDATE user_mfa_factors SET last_used_step = $2, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND state = 'enabled' AND last_used_step < $2
        RETURNING user_id;
      `,
      values: [userId, step],
    });
    return Boolean(rows[0]);
  }

  consumeRecoveryCode(userId: number, codeHash: string): Promise<boolean> {
    return this.database.transaction(async (session) => {
      const rows = await session.query<{ id: number }>({
        text: `
          UPDATE user_mfa_recovery_codes SET used_at = $3
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
          RETURNING id;
        `,
        values: [userId, codeHash, this.now().toISOString()],
      });
      if (!rows[0]) return false;
      await recordEvent(session, userId, 'recovery_code_used');
      return true;
    });
  }

  disable(userId: number): Promise<void> {
    return this.database.transaction(async (session) => {
      const rows = await session.query<FactorRow>({
        text: `SELECT ${FACTOR_COLUMNS} FROM user_mfa_factors WHERE user_id = $1 LIMIT 1;`,
        values: [userId],
      });
      const factor = rows[0];
      if (!factor || factor.state !== 'enabled') throw new Error('MFA is not enabled');
      await session.execute({
        text: 'DELETE FROM user_mfa_challenges WHERE user_id = $1;',
        values: [userId],
      });
      await session.execute({
        text: 'DELETE FROM user_mfa_recovery_codes WHERE user_id = $1;',
        values: [userId],
      });
      await session.execute({
        text: 'DELETE FROM user_mfa_factors WHERE user_id = $1;',
        values: [userId],
      });
      await session.execute({
        text: 'DELETE FROM secrets WHERE secret_ref = $1 AND workspace_id = $2;',
        values: [factor.secret_ref, factor.secret_workspace_id],
      });
      await recordEvent(session, userId, 'disabled');
    });
  }

  createChallenge(
    userId: number,
    purpose: MfaChallengePurpose,
    context: Record<string, unknown> = {},
  ): Promise<{ challengeToken: string; expiresAt: string }> {
    const challengeToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + CHALLENGE_TTL_MS).toISOString();
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          UPDATE user_mfa_challenges SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND purpose = $2
            AND consumed_at IS NULL AND revoked_at IS NULL;
        `,
        values: [userId, purpose],
      });
      await session.execute({
        text: `
          INSERT INTO user_mfa_challenges (
            user_id, token_hash, purpose, context_json, expires_at
          ) VALUES ($1, $2, $3, $4, $5);
        `,
        values: [userId, hashToken(challengeToken), purpose, JSON.stringify(context), expiresAt],
      });
      return { challengeToken, expiresAt };
    });
  }

  async activeChallenge(challengeToken: string): Promise<MfaChallenge | null> {
    if (!challengeToken.trim()) return null;
    const rows = await this.database.query<ChallengeRow>({
      text: `
        SELECT id, user_id, purpose, context_json, attempts, expires_at
        FROM user_mfa_challenges
        WHERE token_hash = $1 AND expires_at > $2 AND attempts < $3
          AND consumed_at IS NULL AND revoked_at IS NULL
        LIMIT 1;
      `,
      values: [hashToken(challengeToken), this.now().toISOString(), MAX_CHALLENGE_ATTEMPTS],
    });
    return rows[0] ? toChallenge(rows[0]) : null;
  }

  recordFailedChallenge(challenge: MfaChallenge): Promise<void> {
    return this.database.transaction(async (session) => {
      await session.execute({
        text: `
          UPDATE user_mfa_challenges SET attempts = attempts + 1
          WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL;
        `,
        values: [challenge.id],
      });
      await recordEvent(session, challenge.userId, 'challenge_failed', {
        purpose: challenge.purpose,
        attempt: challenge.attempts + 1,
      });
    });
  }

  async consumeChallenge(challenge: MfaChallenge): Promise<boolean> {
    const rows = await this.database.query<{ id: number }>({
      text: `
        UPDATE user_mfa_challenges SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at > $2 AND attempts < $3
        RETURNING id;
      `,
      values: [challenge.id, this.now().toISOString(), MAX_CHALLENGE_ATTEMPTS],
    });
    return Boolean(rows[0]);
  }
}

async function replaceRecoveryCodeRows(
  session: AsyncDatabaseSession,
  userId: number,
  recoveryCodeHashes: string[],
): Promise<void> {
  await session.execute({
    text: 'DELETE FROM user_mfa_recovery_codes WHERE user_id = $1;',
    values: [userId],
  });
  const placeholders = recoveryCodeHashes.map((_, index) => `($1, $${index + 2})`).join(', ');
  await session.execute({
    text: `
      INSERT INTO user_mfa_recovery_codes (user_id, code_hash)
      VALUES ${placeholders};
    `,
    values: [userId, ...recoveryCodeHashes],
  });
}

function assertRecoveryCodeHashes(hashes: string[]): void {
  if (hashes.length !== 10 || hashes.some((hash) => !hash.trim())) {
    throw new Error('MFA recovery codes are invalid');
  }
}

function recordEvent(
  session: AsyncDatabaseSession,
  userId: number,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<unknown> {
  return session.execute({
    text: `
      INSERT INTO user_mfa_events (user_id, event_type, metadata_json)
      VALUES ($1, $2, $3);
    `,
    values: [userId, eventType, JSON.stringify(metadata)],
  });
}

function toFactor(row: FactorRow): MfaFactor {
  return {
    userId: Number(row.user_id),
    secretWorkspaceId: Number(row.secret_workspace_id),
    secretRef: row.secret_ref,
    state: row.state,
    lastUsedStep: Number(row.last_used_step),
    enabledAt: nullableDatabaseTimestamp(row.enabled_at),
  };
}

function toChallenge(row: ChallengeRow): MfaChallenge {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    purpose: row.purpose,
    context: JSON.parse(row.context_json) as Record<string, unknown>,
    attempts: Number(row.attempts),
    expiresAt: databaseTimestamp(row.expires_at),
  };
}
