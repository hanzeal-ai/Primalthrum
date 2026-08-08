import { type Awaitable } from './storeTypes';

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

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
  enabledAt: string | null;
}

export interface MfaStore {
  status(userId: number): Awaitable<MfaStatus>;
  factor(userId: number): Awaitable<MfaFactor | null>;
  secret(factor: MfaFactor): Awaitable<string>;
  beginSetup(userId: number, secretWorkspaceId: number, secret: string): Awaitable<void>;
  enable(userId: number, usedStep: number, recoveryCodeHashes: string[]): Awaitable<void>;
  replaceRecoveryCodes(userId: number, recoveryCodeHashes: string[]): Awaitable<void>;
  claimTotpStep(userId: number, step: number): Awaitable<boolean>;
  consumeRecoveryCode(userId: number, codeHash: string): Awaitable<boolean>;
  disable(userId: number): Awaitable<void>;
  createChallenge(
    userId: number,
    purpose: MfaChallengePurpose,
    context?: Record<string, unknown>,
  ): Awaitable<{ challengeToken: string; expiresAt: string }>;
  activeChallenge(challengeToken: string): Awaitable<MfaChallenge | null>;
  recordFailedChallenge(challenge: MfaChallenge): Awaitable<void>;
  consumeChallenge(challenge: MfaChallenge): Awaitable<boolean>;
}
