import {
  createTotpUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp,
} from './totp';
import {
  type MfaAuthenticationMethod,
  type MfaChallengePurpose,
  type MfaStore,
} from './mfaStore';

export class MfaVerificationError extends Error {}

export class MfaService {
  constructor(private readonly repository: MfaStore) {}

  status(userId: number) {
    return this.repository.status(userId);
  }

  async isEnabled(userId: number): Promise<boolean> {
    return (await this.repository.factor(userId))?.state === 'enabled';
  }

  async beginSetup(input: { userId: number; secretWorkspaceId: number; email: string }) {
    const secret = generateTotpSecret();
    await this.repository.beginSetup(input.userId, input.secretWorkspaceId, secret);
    return {
      secret,
      otpauthUri: createTotpUri({
        accountName: input.email,
        issuer: 'Primalthrum',
        secret,
      }),
    };
  }

  async confirmSetup(userId: number, code: unknown): Promise<{ recoveryCodes: string[] }> {
    const factor = await this.repository.factor(userId);
    if (!factor || factor.state !== 'pending') throw new Error('MFA setup has not been started');
    const step = verifyTotp(await this.repository.secret(factor), code);
    if (step === null) throw new MfaVerificationError('invalid authentication code');
    const recoveryCodes = generateRecoveryCodes();
    await this.repository.enable(userId, step, recoveryCodes.map(hashRecoveryCode));
    return { recoveryCodes };
  }

  async regenerateRecoveryCodes(userId: number, code: unknown): Promise<{ recoveryCodes: string[] }> {
    await this.verifyEnabledCredential(userId, code, false);
    const recoveryCodes = generateRecoveryCodes();
    await this.repository.replaceRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode));
    return { recoveryCodes };
  }

  async disable(userId: number, code: unknown): Promise<void> {
    await this.verifyEnabledCredential(userId, code, true);
    await this.repository.disable(userId);
  }

  async createChallenge(
    userId: number,
    purpose: MfaChallengePurpose,
    context: Record<string, unknown> = {},
  ) {
    if (!await this.isEnabled(userId)) throw new Error('MFA is not enabled');
    return {
      mfaRequired: true as const,
      methods: ['totp', 'recovery_code'] as MfaAuthenticationMethod[],
      ...await this.repository.createChallenge(userId, purpose, context),
    };
  }

  async verifyChallenge(challengeToken: unknown, code: unknown): Promise<{
    userId: number;
    purpose: MfaChallengePurpose;
    context: Record<string, unknown>;
    authenticationMethod: MfaAuthenticationMethod;
  }> {
    const token = typeof challengeToken === 'string' ? challengeToken : '';
    const challenge = await this.repository.activeChallenge(token);
    if (!challenge) throw new MfaVerificationError('MFA challenge is invalid or expired');
    let authenticationMethod: MfaAuthenticationMethod;
    try {
      authenticationMethod = await this.verifyEnabledCredential(challenge.userId, code, true);
    } catch (error) {
      await this.repository.recordFailedChallenge(challenge);
      throw error;
    }
    if (!await this.repository.consumeChallenge(challenge)) {
      throw new MfaVerificationError('MFA challenge is invalid or expired');
    }
    return {
      userId: challenge.userId,
      purpose: challenge.purpose,
      context: challenge.context,
      authenticationMethod,
    };
  }

  private async verifyEnabledCredential(
    userId: number,
    code: unknown,
    allowRecoveryCode: boolean,
  ): Promise<MfaAuthenticationMethod> {
    const factor = await this.repository.factor(userId);
    if (!factor || factor.state !== 'enabled') throw new Error('MFA is not enabled');
    const secret = await this.repository.secret(factor);
    const step = verifyTotp(secret, code);
    if (step !== null && await this.repository.claimTotpStep(userId, step)) return 'totp';
    const recoveryCode = allowRecoveryCode ? normalizeRecoveryCode(code) : '';
    if (recoveryCode && await this.repository.consumeRecoveryCode(userId, hashRecoveryCode(recoveryCode))) {
      return 'recovery_code';
    }
    throw new MfaVerificationError('invalid or previously used authentication code');
  }
}
