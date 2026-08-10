import 'dotenv/config';

import { createApp } from './src/app';
import { closeApp } from './src/services/appLifecycle';
import { StripePaymentAdapter } from './src/services/stripePaymentAdapter';
import { HttpUsageMeterExporter } from './src/services/usageMeterExporter';
import { createAccountEmailIntegration } from './src/services/accountEmailConfiguration';
import { createAbuseProtectionConfiguration } from './src/services/abuseProtectionConfiguration';
import { configureApplicationDatabase } from './src/services/applicationDatabaseConfiguration';
import { createDocumentFileStorage } from './src/services/documentStorageConfiguration';

const port = Number(process.env.PORT ?? 3000);
const agentBaseUrl = process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:8000';
const documentStorage = createDocumentFileStorage(process.env);
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
const abuseProtection = createAbuseProtectionConfiguration(process.env);

async function main(): Promise<void> {
  const databaseSelection = await configureApplicationDatabase(process.env);
  const database = databaseSelection.database;
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp({
      agentBaseUrl,
      documentStorage,
      identityDatabase: database,
      runtimeDatabase: database,
      paymentAdapter,
      paymentPriceRefs,
      publicAppUrl: process.env.PUBLIC_APP_URL,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      usageMeterExporter,
      accountEmailSender: accountEmail.sender,
      accountEmailWebhookVerifier: accountEmail.webhookVerifier,
      exposeAccountEmailPreview: accountEmail.exposePreview,
      abuseHashSecret: abuseProtection.hashSecret,
      botChallengeVerifier: abuseProtection.botChallengeVerifier,
      botChallengeSiteKey: abuseProtection.botChallengeSiteKey,
      trustedProxyHops: abuseProtection.trustedProxyHops,
      operatorBootstrapToken: process.env.OPERATOR_BOOTSTRAP_TOKEN,
    });
  } catch (error) {
    await database?.close().catch(() => undefined);
    throw error;
  }

  const server = app.listen(port, () => {
    console.log(`Primalthrum Node server listening on http://127.0.0.1:${port}`);
    console.log(`Agent upstream: ${agentBaseUrl}`);
    console.log(`Database provider: ${databaseSelection.provider}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Primalthrum Node server`);
    const forceExit = setTimeout(() => {
      console.error('Primalthrum Node server shutdown timed out');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(async (serverError) => {
      let closeError: unknown = serverError;
      try {
        await closeApp(app);
      } catch (error) {
        closeError ??= error;
      }
      try {
        await database?.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) {
        console.error(closeError);
        process.exitCode = 1;
      }
      clearTimeout(forceExit);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Primalthrum Node server failed to start');
  process.exitCode = 1;
});
