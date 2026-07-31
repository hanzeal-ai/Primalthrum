import {
  createTotpUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp,
} from './totp';
import {
  MfaRepository,
  type MfaAuthenticationMethod,
  type MfaChallengePurpose,
} from './mfaRepository';

export class MfaVerificationError extends Error {}

export class MfaService {
  constructor(private readonly repository: MfaRepository) {}

  status(userId: number) {
    return this.repository.status(userId);
  }

  isEnabled(userId: number): boolean {
    return this.repository.factor(userId)?.state === 'enabled';
  }

  beginSetup(input: { userId: number; secretWorkspaceId: number; email: string }) {
    const secret = generateTotpSecret();
    this.repository.beginSetup(input.userId, input.secretWorkspaceId, secret);
    return {
      secret,
      otpauthUri: createTotpUri({
        accountName: input.email,
        issuer: 'Primalthrum',
        secret,
      }),
    };
  }

  confirmSetup(userId: number, code: unknown): { recoveryCodes: string[] } {
    const factor = this.repository.factor(userId);
    if (!factor || factor.state !== 'pending') throw new Error('MFA setup has not been started');
    const step = verifyTotp(this.repository.secret(factor), code);
    if (step === null) throw new MfaVerificationError('invalid authentication code');
    const recoveryCodes = generateRecoveryCodes();
    this.repository.enable(userId, step, recoveryCodes.map(hashRecoveryCode));
    return { recoveryCodes };
  }

  regenerateRecoveryCodes(userId: number, code: unknown): { recoveryCodes: string[] } {
    this.verifyEnabledCredential(userId, code, false);
    const recoveryCodes = generateRecoveryCodes();
    this.repository.replaceRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode));
    return { recoveryCodes };
  }

  disable(userId: number, code: unknown): void {
    this.verifyEnabledCredential(userId, code, true);
    this.repository.disable(userId);
  }

  createChallenge(
    userId: number,
    purpose: MfaChallengePurpose,
    context: Record<string, unknown> = {},
  ) {
    if (!this.isEnabled(userId)) throw new Error('MFA is not enabled');
    return {
      mfaRequired: true as const,
      methods: ['totp', 'recovery_code'] as MfaAuthenticationMethod[],
      ...this.repository.createChallenge(userId, purpose, context),
    };
  }

  verifyChallenge(challengeToken: unknown, code: unknown): {
    userId: number;
    purpose: MfaChallengePurpose;
    context: Record<string, unknown>;
    authenticationMethod: MfaAuthenticationMethod;
  } {
    const token = typeof challengeToken === 'string' ? challengeToken : '';
    const challenge = this.repository.activeChallenge(token);
    if (!challenge) throw new MfaVerificationError('MFA challenge is invalid or expired');
    let authenticationMethod: MfaAuthenticationMethod;
    try {
      authenticationMethod = this.verifyEnabledCredential(challenge.userId, code, true);
    } catch (error) {
      this.repository.recordFailedChallenge(challenge);
      throw error;
    }
    if (!this.repository.consumeChallenge(challenge)) {
      throw new MfaVerificationError('MFA challenge is invalid or expired');
    }
    return {
      userId: challenge.userId,
      purpose: challenge.purpose,
      context: challenge.context,
      authenticationMethod,
    };
  }

  private verifyEnabledCredential(
    userId: number,
    code: unknown,
    allowRecoveryCode: boolean,
  ): MfaAuthenticationMethod {
    const factor = this.repository.factor(userId);
    if (!factor || factor.state !== 'enabled') throw new Error('MFA is not enabled');
    const secret = this.repository.secret(factor);
    const step = verifyTotp(secret, code);
    if (step !== null && this.repository.claimTotpStep(userId, step)) return 'totp';
    const recoveryCode = allowRecoveryCode ? normalizeRecoveryCode(code) : '';
    if (recoveryCode && this.repository.consumeRecoveryCode(userId, hashRecoveryCode(recoveryCode))) {
      return 'recovery_code';
    }
    throw new MfaVerificationError('invalid or previously used authentication code');
  }
}
