export function databaseTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();

  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const normalized = value.includes('T')
    ? value
    : value.replace(' ', 'T');
  const parsed = new Date(hasTimezone ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('database timestamp is invalid');
  }
  return parsed.toISOString();
}

export function nullableDatabaseTimestamp(value: string | Date | null): string | null {
  return value === null ? null : databaseTimestamp(value);
}
