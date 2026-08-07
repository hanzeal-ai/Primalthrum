export type SqlValue = string | number | boolean | null;

export function sqlValue(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${value.replace(/'/g, "''")}'`;
}
