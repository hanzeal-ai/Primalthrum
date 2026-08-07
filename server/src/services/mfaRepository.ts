import { randomBytes } from 'node:crypto';

import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { LocalSecretVault } from './localSecretVault';
import { hashToken } from './sessionRepository';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

export type MfaChallengePurpose = 'login' | 'invitation';
export type MfaAuthenticationMethod = 'totp' | 'recovery_code';

export interface MfaFactor {
  userId: number;
  secretWorkspaceId: number;
  secretRef: string;
  state: 'pending' | 'enabled';
  lastUsedStep: number;
  enabledAt: string | null;
}

export interface MfaChallenge {
  id: number;
  userId: number;
  purpose: MfaChallengePurpose;
  context: Record<string, unknown>;
  attempts: number;
  expiresAt: string;
}

interface FactorRow {
  user_id: number;
  secret_workspace_id: number;
  secret_ref: string;
  state: 'pending' | 'enabled';
  last_used_step: number;
  enabled_at: string | null;
}

interface ChallengeRow {
  id: number;
  user_id: number;
  purpose: MfaChallengePurpose;
  context_json: string;
  attempts: number;
  expires_at: string;
}

export class MfaRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly secrets: LocalSecretVault,
  ) {
  }

  status(userId: number): { enabled: boolean; recoveryCodesRemaining: number; enabledAt: string | null } {
    const factor = this.factor(userId);
    const recoveryCodesRemaining = Number(this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM user_mfa_recovery_codes
      WHERE user_id = ${sqlValue(userId)} AND used_at IS NULL;
    `)[0]?.count ?? 0);
    return {
      enabled: factor?.state === 'enabled',
      recoveryCodesRemaining,
      enabledAt: factor?.enabledAt ?? null,
    };
  }

  factor(userId: number): MfaFactor | null {
    const row = this.db.query<FactorRow>(`
      SELECT user_id, secret_workspace_id, secret_ref, state, last_used_step, enabled_at
      FROM user_mfa_factors WHERE user_id = ${sqlValue(userId)} LIMIT 1;
    `)[0];
    return row ? toFactor(row) : null;
  }

  secret(factor: MfaFactor): string {
    return this.secrets.read(factor.secretRef, factor.secretWorkspaceId);
  }

  beginSetup(userId: number, secretWorkspaceId: number, secret: string): void {
    const existing = this.factor(userId);
    if (existing?.state === 'enabled') throw new Error('MFA is already enabled');
    if (existing) this.secrets.delete(existing.secretRef, existing.secretWorkspaceId);
    const secretRef = this.secrets.create(secret, secretWorkspaceId);
    this.db.run(`
      INSERT INTO user_mfa_factors (
        user_id, secret_workspace_id, secret_ref, state, last_used_step
      ) VALUES (
        ${sqlValue(userId)}, ${sqlValue(secretWorkspaceId)}, ${sqlValue(secretRef)}, 'pending', -1
      )
      ON CONFLICT(user_id) DO UPDATE SET
        secret_workspace_id = excluded.secret_workspace_id,
        secret_ref = excluded.secret_ref,
        state = 'pending',
        last_used_step = -1,
        enabled_at = NULL,
        updated_at = CURRENT_TIMESTAMP;
    `);
    this.recordEvent(userId, 'setup_started');
  }

  enable(userId: number, usedStep: number, recoveryCodeHashes: string[]): void {
    const enabledAt = new Date().toISOString();
    const values = recoveryCodeHashes.map((hash) => (
      `(${sqlValue(userId)}, ${sqlValue(hash)})`
    )).join(', ');
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE user_mfa_factors SET
        state = 'enabled',
        last_used_step = ${sqlValue(usedStep)},
        enabled_at = ${sqlValue(enabledAt)},
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ${sqlValue(userId)} AND state = 'pending';
      CREATE TEMP TABLE mfa_enable_assertion (
        changed_rows INTEGER NOT NULL CHECK(changed_rows = 1)
      );
      INSERT INTO mfa_enable_assertion (changed_rows) VALUES (changes());
      DELETE FROM user_mfa_recovery_codes WHERE user_id = ${sqlValue(userId)};
      INSERT INTO user_mfa_recovery_codes (user_id, code_hash) VALUES ${values};
      INSERT INTO user_mfa_events (user_id, event_type, metadata_json)
      VALUES (${sqlValue(userId)}, 'enabled', '{}');
      DROP TABLE mfa_enable_assertion;
      COMMIT;
    `);
  }

  replaceRecoveryCodes(userId: number, recoveryCodeHashes: string[]): void {
    const values = recoveryCodeHashes.map((hash) => (
      `(${sqlValue(userId)}, ${sqlValue(hash)})`
    )).join(', ');
    this.db.run(`
      BEGIN IMMEDIATE;
      DELETE FROM user_mfa_recovery_codes WHERE user_id = ${sqlValue(userId)};
      INSERT INTO user_mfa_recovery_codes (user_id, code_hash) VALUES ${values};
      INSERT INTO user_mfa_events (user_id, event_type, metadata_json)
      VALUES (${sqlValue(userId)}, 'recovery_codes_regenerated', '{}');
      COMMIT;
    `);
  }

  claimTotpStep(userId: number, step: number): boolean {
    return Boolean(this.db.query<{ user_id: number }>(`
      UPDATE user_mfa_factors
      SET last_used_step = ${sqlValue(step)}, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ${sqlValue(userId)}
        AND state = 'enabled'
        AND last_used_step < ${sqlValue(step)}
      RETURNING user_id;
    `)[0]);
  }

  consumeRecoveryCode(userId: number, codeHash: string): boolean {
    const consumed = this.db.query<{ id: number }>(`
      UPDATE user_mfa_recovery_codes
      SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = ${sqlValue(userId)}
        AND code_hash = ${sqlValue(codeHash)}
        AND used_at IS NULL
      RETURNING id;
    `)[0];
    if (!consumed) return false;
    this.recordEvent(userId, 'recovery_code_used');
    return true;
  }

  disable(userId: number): void {
    const factor = this.factor(userId);
    if (!factor || factor.state !== 'enabled') throw new Error('MFA is not enabled');
    this.db.run(`
      BEGIN IMMEDIATE;
      DELETE FROM user_mfa_challenges WHERE user_id = ${sqlValue(userId)};
      DELETE FROM user_mfa_recovery_codes WHERE user_id = ${sqlValue(userId)};
      DELETE FROM user_mfa_factors WHERE user_id = ${sqlValue(userId)};
      INSERT INTO user_mfa_events (user_id, event_type, metadata_json)
      VALUES (${sqlValue(userId)}, 'disabled', '{}');
      COMMIT;
    `);
    this.secrets.delete(factor.secretRef, factor.secretWorkspaceId);
  }

  createChallenge(
    userId: number,
    purpose: MfaChallengePurpose,
    context: Record<string, unknown> = {},
  ): { challengeToken: string; expiresAt: string } {
    const challengeToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    this.db.run(`
      UPDATE user_mfa_challenges SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ${sqlValue(userId)}
        AND purpose = ${sqlValue(purpose)}
        AND consumed_at IS NULL AND revoked_at IS NULL;
      INSERT INTO user_mfa_challenges (
        user_id, token_hash, purpose, context_json, expires_at
      ) VALUES (
        ${sqlValue(userId)},
        ${sqlValue(hashToken(challengeToken))},
        ${sqlValue(purpose)},
        ${sqlValue(JSON.stringify(context))},
        ${sqlValue(expiresAt)}
      );
    `);
    return { challengeToken, expiresAt };
  }

  activeChallenge(challengeToken: string): MfaChallenge | null {
    if (!challengeToken.trim()) return null;
    const row = this.db.query<ChallengeRow>(`
      SELECT id, user_id, purpose, context_json, attempts, expires_at
      FROM user_mfa_challenges
      WHERE token_hash = ${sqlValue(hashToken(challengeToken))}
        AND expires_at > ${sqlValue(new Date().toISOString())}
        AND attempts < ${MAX_CHALLENGE_ATTEMPTS}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
      LIMIT 1;
    `)[0];
    return row ? toChallenge(row) : null;
  }

  recordFailedChallenge(challenge: MfaChallenge): void {
    this.db.run(`
      UPDATE user_mfa_challenges SET attempts = attempts + 1
      WHERE id = ${sqlValue(challenge.id)} AND consumed_at IS NULL AND revoked_at IS NULL;
    `);
    this.recordEvent(challenge.userId, 'challenge_failed', {
      purpose: challenge.purpose,
      attempt: challenge.attempts + 1,
    });
  }

  consumeChallenge(challenge: MfaChallenge): boolean {
    return Boolean(this.db.query<{ id: number }>(`
      UPDATE user_mfa_challenges SET consumed_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(challenge.id)}
        AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > ${sqlValue(new Date().toISOString())}
        AND attempts < ${MAX_CHALLENGE_ATTEMPTS}
      RETURNING id;
    `)[0]);
  }

  private recordEvent(
    userId: number,
    eventType: string,
    metadata: Record<string, unknown> = {},
  ): void {
    this.db.run(`
      INSERT INTO user_mfa_events (user_id, event_type, metadata_json)
      VALUES (${sqlValue(userId)}, ${sqlValue(eventType)}, ${sqlValue(JSON.stringify(metadata))});
    `);
  }
}

function toFactor(row: FactorRow): MfaFactor {
  return {
    userId: Number(row.user_id),
    secretWorkspaceId: Number(row.secret_workspace_id),
    secretRef: row.secret_ref,
    state: row.state,
    lastUsedStep: Number(row.last_used_step),
    enabledAt: normalizeTimestamp(row.enabled_at),
  };
}

function normalizeTimestamp(value: string | null): string | null {
  if (!value || value.includes('T')) return value;
  return `${value.replace(' ', 'T')}Z`;
}

function toChallenge(row: ChallengeRow): MfaChallenge {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    purpose: row.purpose,
    context: JSON.parse(row.context_json) as Record<string, unknown>,
    attempts: Number(row.attempts),
    expiresAt: row.expires_at,
  };
}
