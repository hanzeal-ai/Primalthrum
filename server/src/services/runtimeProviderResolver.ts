import { type AgentConfig } from './agentRepository';
import {
  type ProviderConfigRecord,
} from './providerConfigRepository';
import { type ProviderConfigStore } from './providerConfigStore';
import { normalizeProviderBaseUrl } from './providerEndpointPolicy';
import { type SecretStore } from './secretStore';

export interface RuntimeModelEndpoint {
  provider: string;
  model: string;
  api_key?: string;
  base_url?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface RuntimeProviderSelection {
  llm: RuntimeModelEndpoint;
  embedding: RuntimeModelEndpoint;
}

type ModelSlot = 'default' | 'embedding';

export class RuntimeProviderResolver {
  constructor(
    private readonly providers: ProviderConfigStore,
    private readonly secrets: SecretStore,
  ) {}

  async resolve(config: AgentConfig, workspaceId: number): Promise<RuntimeProviderSelection> {
    return {
      llm: await this.resolveSlot(config.modelConfig.default, 'default', workspaceId),
      embedding: await this.resolveSlot(config.modelConfig.embedding, 'embedding', workspaceId),
    };
  }

  private async resolveSlot(
    input: unknown,
    slot: ModelSlot,
    workspaceId: number,
  ): Promise<RuntimeModelEndpoint> {
    const selection = asRecord(input);
    const providerName = text(selection.provider) || 'mock';
    const defaultModel = slot === 'default' ? 'mock-chat' : 'mock-embedding';
    if (providerName === 'mock') {
      return { provider: 'mock', model: text(selection.model) || defaultModel };
    }

    const provider = await this.findProvider(selection, providerName, slot, workspaceId);
    const configuredProvider = text(provider.config.provider);
    if (!configuredProvider) throw new Error('provider config provider is required');
    const model = text(selection.model) || text(provider.config.model);
    if (!model) throw new Error(`provider model is required for ${slot}`);
    if (!provider.secretRef) throw new Error(`provider secret is required for ${provider.name}`);

    const endpoint: RuntimeModelEndpoint = {
      provider: configuredProvider,
      model,
      api_key: await this.secrets.read(provider.secretRef, workspaceId),
    };
    const baseUrl = text(provider.config.baseUrl);
    if (baseUrl) endpoint.base_url = normalizeProviderBaseUrl(baseUrl);
    const temperature = optionalNumber(provider.config.temperature, 'temperature', 0, 2);
    if (temperature !== undefined) endpoint.temperature = temperature;
    const maxTokens = optionalInteger(provider.config.maxTokens, 'maxTokens', 1, 128_000);
    if (maxTokens !== undefined) endpoint.max_tokens = maxTokens;
    return endpoint;
  }

  private async findProvider(
    selection: Record<string, unknown>,
    providerName: string,
    slot: ModelSlot,
    workspaceId: number,
  ): Promise<ProviderConfigRecord> {
    const providerConfigId = optionalInteger(
      selection.providerConfigId,
      'providerConfigId',
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (providerConfigId) {
      const provider = await this.providers.findById(providerConfigId, workspaceId);
      if (!provider || !supportsSlot(provider.type, slot)) {
        throw new Error('provider config not found');
      }
      return provider;
    }

    const matches = (await this.providers.list(workspaceId)).filter((provider) => (
      supportsSlot(provider.type, slot)
      && text(provider.config.provider) === providerName
    ));
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `providerConfigId is required when multiple ${providerName} configs exist`
          : `configured provider ${providerName} not found`,
      );
    }
    return matches[0];
  }
}

function supportsSlot(type: string, slot: ModelSlot): boolean {
  return slot === 'default' ? type === 'llm' : type === 'embedding';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  const parsed = optionalNumber(value, label, min, max);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}
