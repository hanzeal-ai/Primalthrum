export interface RuntimeCapabilityManifest {
  kind: string;
  name: string;
  version: string;
  description: string;
  status: 'available' | 'planned';
  hotPluggable: boolean;
  configSchema: Record<string, unknown>;
  permissions: string[];
  dependencies: string[];
}

export interface RuntimeCapabilityCatalog {
  schemaVersion: string;
  capabilities: RuntimeCapabilityManifest[];
  health: Array<{ key: string; status: string }>;
}

export async function fetchCapabilityCatalog(
  agentBaseUrl: string,
): Promise<RuntimeCapabilityCatalog> {
  const response = await fetch(`${agentBaseUrl}/capabilities`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Agent capability service returned HTTP ${response.status}`);
  }
  const catalog = await response.json() as RuntimeCapabilityCatalog;
  if (catalog.schemaVersion !== '1.0' || !Array.isArray(catalog.capabilities)) {
    throw new Error('Agent capability catalog has an unsupported schema');
  }
  return catalog;
}

export function capabilityKey(capability: Pick<RuntimeCapabilityManifest, 'kind' | 'name'>): string {
  return `${capability.kind}:${capability.name}`;
}
