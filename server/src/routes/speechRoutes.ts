import Router from '@koa/router';
import type Koa from 'koa';

import { AgentSpeechClient } from '../services/agentSpeechClient';
import { sendApiError } from '../services/apiErrors';
import { BillingError } from '../services/billingRepository';
import {
  CapabilityDisabledError,
  CapabilitySettingsRepository,
} from '../services/capabilitySettingsRepository';
import { type StructuredLogger } from '../services/logger';
import {
  MeteredOperationService,
  type MeteredOperation,
} from '../services/meteredOperationService';
import { RuntimeSpeechResolver } from '../services/runtimeSpeechResolver';
import {
  parseAudioDurationSeconds,
  parseAudioPayload,
  parseSpeechText,
} from '../services/speechPayload';
import { UsageRatingError } from '../services/usageRatingTypes';
import { type WorkspacePermission } from '../services/workspaceAuthorization';

interface SpeechRouteDependencies {
  authorize: (ctx: Koa.Context, permission: WorkspacePermission) => boolean;
  capabilities: CapabilitySettingsRepository;
  currentWorkspaceId: (ctx: Koa.Context) => number;
  logger: StructuredLogger;
  metering: MeteredOperationService;
  resolver: RuntimeSpeechResolver;
  speech: AgentSpeechClient;
}

export function registerSpeechRoutes(
  router: Router,
  dependencies: SpeechRouteDependencies,
): void {
  const { authorize, capabilities, currentWorkspaceId, logger, metering, resolver, speech } = dependencies;

  router.post('/api/speech/transcriptions', async (ctx) => {
    if (!authorize(ctx, 'agents.run')) return;
    let operation: MeteredOperation | null = null;
    let providerConsumed = false;
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const providerConfigId = optionalPositiveInteger(body.providerConfigId);
      const audio = parseAudioPayload({
        filename: body.filename,
        mimeType: body.mimeType,
        audioBase64: body.audioBase64,
      });
      const workspaceId = currentWorkspaceId(ctx);
      const provider = await resolver.resolve('stt', workspaceId, providerConfigId);
      capabilities.assertEnabled(
        capabilities.snapshot(workspaceId, [`stt:${provider.provider}`]),
      );
      operation = metering.begin({
        workspaceId,
        idempotencyKey: requestIdempotencyKey(ctx),
        meter: 'speech.transcription_seconds',
        quantity: parseAudioDurationSeconds(body.durationMs),
        provider: provider.provider,
        model: provider.model,
        resourceType: 'speech.transcription',
      });
      const result = await speech.transcribe(provider, audio);
      providerConsumed = true;
      metering.complete(operation, { sizeBytes: audio.sizeBytes });
      ctx.body = result;
    } catch (error) {
      if (operation && !providerConsumed) safeRelease(metering, operation, logger);
      speechError(ctx, logger, error, 'speech transcription failed');
    }
  });

  router.post('/api/speech/synthesis', async (ctx) => {
    if (!authorize(ctx, 'agents.run')) return;
    let operation: MeteredOperation | null = null;
    let providerConsumed = false;
    try {
      const body = ctx.request.body as Record<string, unknown>;
      const providerConfigId = optionalPositiveInteger(body.providerConfigId);
      const workspaceId = currentWorkspaceId(ctx);
      const provider = await resolver.resolve('tts', workspaceId, providerConfigId);
      capabilities.assertEnabled(
        capabilities.snapshot(workspaceId, [`tts:${provider.provider}`]),
      );
      const text = parseSpeechText(body.text);
      operation = metering.begin({
        workspaceId,
        idempotencyKey: requestIdempotencyKey(ctx),
        meter: 'speech.synthesis_characters',
        quantity: text.length,
        provider: provider.provider,
        model: provider.model,
        resourceType: 'speech.synthesis',
      });
      const result = await speech.synthesize(
        provider,
        text,
        typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : 'alloy',
      );
      providerConsumed = true;
      metering.complete(operation);
      ctx.body = result;
    } catch (error) {
      if (operation && !providerConsumed) safeRelease(metering, operation, logger);
      speechError(ctx, logger, error, 'speech synthesis failed');
    }
  });
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('providerConfigId must be a positive integer');
  }
  return parsed;
}

function requestIdempotencyKey(ctx: Koa.Context): string {
  const key = ctx.get('idempotency-key').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new Error('Idempotency-Key has an invalid format');
  }
  return key;
}

function safeRelease(
  metering: MeteredOperationService,
  operation: MeteredOperation,
  logger: StructuredLogger,
): void {
  try {
    metering.release(operation);
  } catch (error) {
    logger.log({
      level: 'warn',
      code: 'METERED_OPERATION_RELEASE_SKIPPED',
      message: error instanceof Error ? error.message : 'metered operation release failed',
      context: { resourceType: operation.resourceType, resourceId: operation.resourceId },
    });
  }
}

function speechError(
  ctx: Koa.Context,
  logger: StructuredLogger,
  error: unknown,
  fallback: string,
): void {
  if (error instanceof CapabilityDisabledError) {
    sendApiError(ctx, logger, {
      status: 409,
      code: 'CAPABILITY_DISABLED',
      message: error.message,
      details: { capabilities: error.capabilityKeys },
    });
    return;
  }
  const upstreamFailure = error instanceof Error
    && error.message.startsWith('speech service returned HTTP');
  const quotaFailure = error instanceof BillingError || error instanceof UsageRatingError;
  sendApiError(ctx, logger, {
    status: quotaFailure ? 402 : upstreamFailure ? 502 : 400,
    code: quotaFailure
      ? 'CREDIT_LIMIT_EXCEEDED'
      : upstreamFailure ? 'SPEECH_PROVIDER_FAILED' : 'SPEECH_REQUEST_INVALID',
    message: error instanceof Error ? error.message : fallback,
  });
}
