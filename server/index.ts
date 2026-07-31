import 'dotenv/config';

import { createApp } from './src/app';
import { StripePaymentAdapter } from './src/services/stripePaymentAdapter';
import { HttpUsageMeterExporter } from './src/services/usageMeterExporter';
import { createAccountEmailIntegration } from './src/services/accountEmailConfiguration';

const port = Number(process.env.PORT ?? 3000);
const agentBaseUrl = process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:8000';
const documentStorageDir = process.env.DOCUMENT_STORAGE_DIR;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
const paymentAdapter = stripeSecretKey
  ? new StripePaymentAdapter(
      stripeSecretKey,
      fetch,
      'https://api.stripe.com',
      process.env.STRIPE_API_VERSION,
    )
  : undefined;
const paymentPriceRefs = Object.fromEntries(
  [
    ['pro', process.env.STRIPE_PRICE_PRO],
    ['team', process.env.STRIPE_PRICE_TEAM],
    ['business', process.env.STRIPE_PRICE_BUSINESS],
    ['enterprise', process.env.STRIPE_PRICE_ENTERPRISE],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
);
const usageMeterExportUrl = process.env.USAGE_METER_EXPORT_URL?.trim();
const usageMeterExporter = usageMeterExportUrl
  ? new HttpUsageMeterExporter(
      usageMeterExportUrl,
      process.env.USAGE_METER_EXPORT_TOKEN?.trim(),
    )
  : undefined;
const accountEmail = createAccountEmailIntegration(process.env);

const app = createApp({
  agentBaseUrl,
  documentStorageDir,
  paymentAdapter,
  paymentPriceRefs,
  publicAppUrl: process.env.PUBLIC_APP_URL,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  usageMeterExporter,
  accountEmailSender: accountEmail.sender,
  accountEmailWebhookVerifier: accountEmail.webhookVerifier,
  exposeAccountEmailPreview: accountEmail.exposePreview,
});

app.listen(port, () => {
  console.log(`Primalthrum Node server listening on http://127.0.0.1:${port}`);
  console.log(`Agent upstream: ${agentBaseUrl}`);
});
