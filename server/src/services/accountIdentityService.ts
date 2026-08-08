import { type BillingStore } from './billingStore';
import { type AccountEmailOutboxStore } from './accountEmailOutboxStore';
import { type AccountOnboardingStore } from './accountOnboardingStore';
import { type AccountTokenStore } from './accountTokenStore';
import { type UserStore } from './userStore';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;

export class AccountIdentityService {
  constructor(
    private readonly users: UserStore,
    private readonly tokens: AccountTokenStore,
    private readonly emails: AccountEmailOutboxStore,
    private readonly onboarding: AccountOnboardingStore,
    private readonly billing: BillingStore,
    private readonly publicAppUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async beginRegistration(input: {
    userId: number;
    workspaceId: number;
    email: string;
    planKey: 'free' | 'pro';
  }): Promise<string> {
    await this.onboarding.create(input.workspaceId, input.userId, input.planKey);
    return this.issueVerification(input.userId, input.email);
  }

  async resendVerification(userId: number): Promise<string | null> {
    const user = await this.users.findById(userId);
    if (!user || user.emailVerifiedAt) return null;
    return this.issueVerification(user.id, user.email);
  }

  async verifyEmail(token: string) {
    const consumed = await this.tokens.consume(token, 'verify_email');
    if (!consumed) throw new Error('email verification token is invalid or expired');
    const onboarding = await this.onboarding.findForUser(consumed.userId);
    if (!onboarding) throw new Error('account onboarding state is missing');
    const verifiedAt = this.now().toISOString();
    await this.users.markEmailVerified(consumed.userId, verifiedAt);
    const trial = onboarding.selectedPlanKey === 'pro'
      ? await this.billing.activateTrial(onboarding.workspaceId, consumed.userId, 'pro')
      : null;
    const entitlementSnapshot = await this.billing.entitlementSnapshot(onboarding.workspaceId);
    const creditAccount = await this.billing.creditAccount(onboarding.workspaceId);
    await this.onboarding.activate(onboarding.workspaceId, verifiedAt);
    return { onboarding, trial, entitlementSnapshot, creditAccount };
  }

  async requestPasswordReset(email: string): Promise<string | null> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.emailVerifiedAt) return null;
    await this.emails.supersedePending(user.id, 'reset_password');
    const token = await this.tokens.create({ userId: user.id, purpose: 'reset_password', ttlMs: RESET_TTL_MS });
    const actionUrl = `${this.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.emails.enqueue({ template: 'reset_password', recipientEmail: user.email,
      payload: { userId: user.id, actionUrl } });
    return actionUrl;
  }

  async consumePasswordReset(token: string): Promise<number> {
    const consumed = await this.tokens.consume(token, 'reset_password');
    if (!consumed) throw new Error('password reset token is invalid or expired');
    return consumed.userId;
  }

  private async issueVerification(userId: number, email: string): Promise<string> {
    await this.emails.supersedePending(userId, 'verify_email');
    const token = await this.tokens.create({ userId, purpose: 'verify_email', ttlMs: VERIFY_TTL_MS });
    const actionUrl = `${this.publicAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await this.emails.enqueue({ template: 'verify_email', recipientEmail: email,
      payload: { userId, actionUrl } });
    return actionUrl;
  }
}
