import {
  type AccountEmailDeliveryReceipt,
  type AccountEmailMessage,
  type AccountEmailSender,
} from './accountEmailSender';

export class MockAccountEmailSender implements AccountEmailSender {
  async send(message: AccountEmailMessage): Promise<AccountEmailDeliveryReceipt> {
    return {
      provider: 'mock',
      providerMessageId: `mock-email-${message.id}`,
    };
  }
}
