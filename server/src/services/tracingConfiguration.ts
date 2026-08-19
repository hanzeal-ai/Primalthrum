import { type HttpTraceExporter } from './httpTraceExporter';
import { OtlpHttpTraceExporter } from './otlpHttpTraceExporter';

export function createTraceExporter(environment: NodeJS.ProcessEnv): HttpTraceExporter | undefined {
  const mode = environment.OTEL_TRACES_EXPORTER?.trim().toLowerCase();
  if (mode === 'none') return undefined;
  if (mode && mode !== 'otlp') throw new Error('OTEL_TRACES_EXPORTER must be otlp or none');

  const endpoint = tracesEndpoint(environment);
  if (!endpoint) {
    if (mode === 'otlp') throw new Error('OTLP traces endpoint is required when tracing is enabled');
    return undefined;
  }
  return new OtlpHttpTraceExporter({
    endpoint,
    serviceName: environment.OTEL_SERVICE_NAME?.trim() || 'primalthrum-server',
    serviceVersion: environment.OTEL_SERVICE_VERSION?.trim() || undefined,
    deploymentEnvironment: environment.OTEL_DEPLOYMENT_ENVIRONMENT?.trim()
      || environment.NODE_ENV?.trim()
      || undefined,
    headers: parseHeaders(environment.OTEL_EXPORTER_OTLP_HEADERS),
    timeoutMs: optionalBoundedInteger(
      environment.OTEL_EXPORTER_OTLP_TIMEOUT,
      100,
      60_000,
      'OTEL_EXPORTER_OTLP_TIMEOUT',
    ),
  });
}

function tracesEndpoint(environment: NodeJS.ProcessEnv): string | undefined {
  const specific = environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return specific;
  const baseValue = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseValue) return undefined;
  const base = new URL(baseValue);
  base.pathname = `${base.pathname.replace(/\/$/, '')}/v1/traces`;
  return base.toString();
}

function parseHeaders(value?: string): Record<string, string> {
  if (!value?.trim()) return {};
  return Object.fromEntries(value.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('OTEL_EXPORTER_OTLP_HEADERS is invalid');
    const key = entry.slice(0, separator).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
      throw new Error('OTEL_EXPORTER_OTLP_HEADERS contains an invalid name');
    }
    if (['content-length', 'content-type', 'host'].includes(key.toLowerCase())) {
      throw new Error(`OTEL_EXPORTER_OTLP_HEADERS cannot set ${key}`);
    }
    try {
      return [key, decodeURIComponent(entry.slice(separator + 1).trim())];
    } catch {
      throw new Error('OTEL_EXPORTER_OTLP_HEADERS contains invalid encoding');
    }
  }));
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
