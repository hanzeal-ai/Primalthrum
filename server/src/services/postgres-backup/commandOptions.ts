export function argumentValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function requiredArgument(args: readonly string[], flag: string): string {
  const value = argumentValue(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

export function optionalBatchSize(args: readonly string[]): number | undefined {
  const value = argumentValue(args, '--batch-size');
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('--batch-size must be an integer');
  return parsed;
}

export function sanitizedCommandError(error: unknown, secret: string | undefined): string {
  const message = error instanceof Error ? error.message : 'PostgreSQL recovery command failed';
  return secret ? message.split(secret).join('[redacted]') : message;
}
