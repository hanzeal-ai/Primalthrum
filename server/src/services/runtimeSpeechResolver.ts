import { LocalSecretVault } from './localSecretVault';
import { normalizeProviderBaseUrl } from './providerEndpointPolicy';
import {
  ProviderConfigRepository,
  type ProviderConfigRecord,
} from './providerConfigRepository';
import { type RuntimeModelEndpoint } from './runtimeProviderResolver';

export type SpeechProviderType = 'stt' | 'tts';

export class RuntimeSpeechResolver {
  constructor(
    private readonly providers: ProviderConfigRepository,
    private readonly secrets: LocalSecretVault,
  ) {}

  resolve(
    type: SpeechProviderType,
    workspaceId: number,
    providerConfigId?: number,
  ): RuntimeModelEndpoint {
    const provider = this.select(type, workspaceId, providerConfigId);
    const providerName = text(provider.config.provider);
    const model = text(provider.config.model);
    if (!providerName || !model) {
      throw new Error(`${type} provider and model are required`);
    }
    if (!provider.secretRef) throw new Error(`provider secret is required for ${provider.name}`);

    const endpoint: RuntimeModelEndpoint = {
      provider: providerName,
      model,
      api_key: this.secrets.read(provider.secretRef, workspaceId),
    };
    const baseUrl = text(provider.config.baseUrl);
    if (baseUrl) endpoint.base_url = normalizeProviderBaseUrl(baseUrl);
    return endpoint;
  }

  private select(
    type: SpeechProviderType,
    workspaceId: number,
    providerConfigId?: number,
  ): ProviderConfigRecord {
    if (providerConfigId) {
      const provider = this.providers.findById(providerConfigId, workspaceId);
      if (!provider || provider.type !== type) throw new Error(`${type} provider config not found`);
      return provider;
    }
    const matches = this.providers.list(workspaceId).filter((provider) => provider.type === type);
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `providerConfigId is required when multiple ${type} configs exist`
          : `${type} provider config not found`,
      );
    }
    return matches[0]!;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
