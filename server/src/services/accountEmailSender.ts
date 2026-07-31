export interface AccountEmailMessage {
  id: number;
  template: 'verify_email' | 'reset_password';
  recipientEmail: string;
  payload: Record<string, unknown>;
}

export interface AccountEmailSender {
  send(message: AccountEmailMessage): Promise<void>;
}

export class HttpAccountEmailSender implements AccountEmailSender {
  constructor(
    private readonly endpoint: string,
    private readonly token = '',
    private readonly from = '',
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    new URL(endpoint);
  }

  async send(message: AccountEmailMessage): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `primalthrum-account-email-${message.id}`,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ ...message, from: this.from }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`account email delivery failed with status ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
