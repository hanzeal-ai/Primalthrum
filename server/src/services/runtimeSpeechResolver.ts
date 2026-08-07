import { normalizeProviderBaseUrl } from './providerEndpointPolicy';
import {
  type ProviderConfigRecord,
} from './providerConfigRepository';
import { type ProviderConfigStore } from './providerConfigStore';
import { type RuntimeModelEndpoint } from './runtimeProviderResolver';
import { type SecretStore } from './secretStore';

export type SpeechProviderType = 'stt' | 'tts';

export class RuntimeSpeechResolver {
  constructor(
    private readonly providers: ProviderConfigStore,
    private readonly secrets: SecretStore,
  ) {}

  async resolve(
    type: SpeechProviderType,
    workspaceId: number,
    providerConfigId?: number,
  ): Promise<RuntimeModelEndpoint> {
    const provider = await this.select(type, workspaceId, providerConfigId);
    const providerName = text(provider.config.provider);
    const model = text(provider.config.model);
    if (!providerName || !model) {
      throw new Error(`${type} provider and model are required`);
    }
    if (!provider.secretRef) throw new Error(`provider secret is required for ${provider.name}`);

    const endpoint: RuntimeModelEndpoint = {
      provider: providerName,
      model,
      api_key: await this.secrets.read(provider.secretRef, workspaceId),
    };
    const baseUrl = text(provider.config.baseUrl);
    if (baseUrl) endpoint.base_url = normalizeProviderBaseUrl(baseUrl);
    return endpoint;
  }

  private async select(
    type: SpeechProviderType,
    workspaceId: number,
    providerConfigId?: number,
  ): Promise<ProviderConfigRecord> {
    if (providerConfigId) {
      const provider = await this.providers.findById(providerConfigId, workspaceId);
      if (!provider || provider.type !== type) throw new Error(`${type} provider config not found`);
      return provider;
    }
    const matches = (await this.providers.list(workspaceId))
      .filter((provider) => provider.type === type);
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
