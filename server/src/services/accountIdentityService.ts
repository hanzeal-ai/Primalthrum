import { BillingRepository } from './billingRepository';
import { AccountEmailOutboxRepository } from './accountEmailOutboxRepository';
import { AccountOnboardingRepository } from './accountOnboardingRepository';
import { AccountTokenRepository } from './accountTokenRepository';
import { type UserStore } from './userStore';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;

export class AccountIdentityService {
  constructor(
    private readonly users: UserStore,
    private readonly tokens: AccountTokenRepository,
    private readonly emails: AccountEmailOutboxRepository,
    private readonly onboarding: AccountOnboardingRepository,
    private readonly billing: BillingRepository,
    private readonly publicAppUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  beginRegistration(input: {
    userId: number;
    workspaceId: number;
    email: string;
    planKey: 'free' | 'pro';
  }): string {
    this.onboarding.create(input.workspaceId, input.userId, input.planKey);
    return this.issueVerification(input.userId, input.email);
  }

  async resendVerification(userId: number): Promise<string | null> {
    const user = await this.users.findById(userId);
    if (!user || user.emailVerifiedAt) return null;
    return this.issueVerification(user.id, user.email);
  }

  async verifyEmail(token: string) {
    const consumed = this.tokens.consume(token, 'verify_email');
    if (!consumed) throw new Error('email verification token is invalid or expired');
    const onboarding = this.onboarding.findForUser(consumed.userId);
    if (!onboarding) throw new Error('account onboarding state is missing');
    const verifiedAt = this.now().toISOString();
    await this.users.markEmailVerified(consumed.userId, verifiedAt);
    const trial = onboarding.selectedPlanKey === 'pro'
      ? this.billing.activateTrial(onboarding.workspaceId, consumed.userId, 'pro')
      : null;
    const entitlementSnapshot = this.billing.entitlementSnapshot(onboarding.workspaceId);
    const creditAccount = this.billing.creditAccount(onboarding.workspaceId);
    this.onboarding.activate(onboarding.workspaceId, verifiedAt);
    return { onboarding, trial, entitlementSnapshot, creditAccount };
  }

  async requestPasswordReset(email: string): Promise<string | null> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.emailVerifiedAt) return null;
    this.emails.supersedePending(user.id, 'reset_password');
    const token = this.tokens.create({ userId: user.id, purpose: 'reset_password', ttlMs: RESET_TTL_MS });
    const actionUrl = `${this.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
    this.emails.enqueue({ template: 'reset_password', recipientEmail: user.email,
      payload: { userId: user.id, actionUrl } });
    return actionUrl;
  }

  consumePasswordReset(token: string): number {
    const consumed = this.tokens.consume(token, 'reset_password');
    if (!consumed) throw new Error('password reset token is invalid or expired');
    return consumed.userId;
  }

  private issueVerification(userId: number, email: string): string {
    this.emails.supersedePending(userId, 'verify_email');
    const token = this.tokens.create({ userId, purpose: 'verify_email', ttlMs: VERIFY_TTL_MS });
    const actionUrl = `${this.publicAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
    this.emails.enqueue({ template: 'verify_email', recipientEmail: email,
      payload: { userId, actionUrl } });
    return actionUrl;
  }
}
