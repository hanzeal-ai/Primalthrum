export function normalizeBillingKey(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} has an invalid format`);
  }
  return normalized;
}

export function normalizeBillingReference(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function positiveBillingInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

export function nonNegativeBillingInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

export function normalizeBillingTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return parsed.toISOString();
}

export function parseBillingJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}
