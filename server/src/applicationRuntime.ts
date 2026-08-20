import { createApp, type AppOptions } from './app';
import { type AsyncDatabaseAdapter } from './db/asyncAdapter';
import { createAbuseProtectionConfiguration } from './services/abuseProtectionConfiguration';
import { createAccountEmailIntegration } from './services/accountEmailConfiguration';
import {
  configureApplicationDatabase,
  type ApplicationDatabaseProvider,
} from './services/applicationDatabaseConfiguration';
import { createDocumentFileStorage } from './services/documentStorageConfiguration';
import { StripePaymentAdapter } from './services/stripePaymentAdapter';
import { HttpUsageMeterExporter } from './services/usageMeterExporter';
import { createTraceExporter } from './services/tracingConfiguration';

export interface ApplicationRuntimeOptions {
  backgroundTimersUnref?: boolean;
  startBackgroundSchedulers?: boolean;
}

export interface ApplicationRuntime {
  agentBaseUrl: string;
  app: ReturnType<typeof createApp>;
  database?: AsyncDatabaseAdapter;
  databaseProvider: ApplicationDatabaseProvider;
}

export async function createApplicationRuntime(
  environment: NodeJS.ProcessEnv,
  options: ApplicationRuntimeOptions = {},
): Promise<ApplicationRuntime> {
  const databaseSelection = await configureApplicationDatabase(environment);
  const database = databaseSelection.database;
  const agentBaseUrl = environment.AGENT_BASE_URL ?? 'http://127.0.0.1:8000';
  try {
    const app = createApp({
      ...createApplicationAppOptions(environment),
      agentBaseUrl,
      identityDatabase: database,
      runtimeDatabase: database,
      backgroundTimersUnref: options.backgroundTimersUnref,
      startBackgroundSchedulers: options.startBackgroundSchedulers,
    });
    return {
      agentBaseUrl,
      app,
      database,
      databaseProvider: databaseSelection.provider,
    };
  } catch (error) {
    await database?.close().catch(() => undefined);
    throw error;
  }
}

export function createApplicationAppOptions(environment: NodeJS.ProcessEnv): AppOptions {
  const traceExporter = createTraceExporter(environment);
  const stripeSecretKey = environment.STRIPE_SECRET_KEY?.trim();
  const paymentAdapter = stripeSecretKey
    ? new StripePaymentAdapter(
        stripeSecretKey,
        fetch,
        'https://api.stripe.com',
        environment.STRIPE_API_VERSION,
      )
    : undefined;
  const paymentPriceRefs = Object.fromEntries(
    [
      ['pro', environment.STRIPE_PRICE_PRO],
      ['team', environment.STRIPE_PRICE_TEAM],
      ['business', environment.STRIPE_PRICE_BUSINESS],
      ['enterprise', environment.STRIPE_PRICE_ENTERPRISE],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
  const usageMeterExportUrl = environment.USAGE_METER_EXPORT_URL?.trim();
  const accountEmail = createAccountEmailIntegration(environment);
  const abuseProtection = createAbuseProtectionConfiguration(environment);

  return {
    documentStorage: createDocumentFileStorage(environment),
    paymentAdapter,
    paymentPriceRefs,
    publicAppUrl: environment.PUBLIC_APP_URL,
    stripeWebhookSecret: environment.STRIPE_WEBHOOK_SECRET,
    usageMeterExporter: usageMeterExportUrl
      ? new HttpUsageMeterExporter(
          usageMeterExportUrl,
          environment.USAGE_METER_EXPORT_TOKEN?.trim(),
        )
      : undefined,
    accountEmailSender: accountEmail.sender,
    accountEmailWebhookVerifier: accountEmail.webhookVerifier,
    exposeAccountEmailPreview: accountEmail.exposePreview,
    abuseHashSecret: abuseProtection.hashSecret,
    botChallengeVerifier: abuseProtection.botChallengeVerifier,
    botChallengeSiteKey: abuseProtection.botChallengeSiteKey,
    trustedProxyHops: abuseProtection.trustedProxyHops,
    operatorBootstrapToken: environment.OPERATOR_BOOTSTRAP_TOKEN,
    traceExporter,
    workerTraceExporter: traceExporter,
    jobLeaseDurationMs: optionalBoundedInteger(
      environment.JOB_LEASE_DURATION_MS,
      1_000,
      60 * 60_000,
      'JOB_LEASE_DURATION_MS',
    ),
    jobPollIntervalMs: optionalBoundedInteger(
      environment.JOB_POLL_INTERVAL_MS,
      25,
      60_000,
      'JOB_POLL_INTERVAL_MS',
    ),
  };
}

export function usesExternalWorker(environment: NodeJS.ProcessEnv): boolean {
  const mode = environment.BACKGROUND_WORKER_MODE?.trim().toLowerCase() || 'embedded';
  if (mode !== 'embedded' && mode !== 'external') {
    throw new Error('BACKGROUND_WORKER_MODE must be embedded or external');
  }
  return mode === 'external';
}

function optionalBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  name: string,
): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}
