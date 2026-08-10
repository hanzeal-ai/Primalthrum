import {
  type AsyncDatabaseSession,
  type DatabaseParameter,
} from '../../db/asyncAdapter';
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_SLUG } from '../../db/workspaceDefaults';
import { quoteTransferIdentifier } from './catalog';
import { countTransferRows, readTransferRows } from './tableTransfer';
import { type TransferTable } from './types';

const BOOTSTRAP_ROW_COUNTS = new Map<string, number>([
  ['billing_plans', 5],
  ['credit_accounts', 1],
  ['meter_prices', 11],
  ['plan_entitlements', 42],
  ['pricing_versions', 1],
  ['workspace_subscriptions', 1],
  ['workspaces', 1],
]);
const PLAN_KEYS = new Set(['free', 'pro', 'team', 'business', 'enterprise']);
const FEATURE_KEYS = new Set([
  'agents.create', 'api', 'audit', 'private.deployment', 'publishing', 'rag',
  'retention.controls', 'seats', 'source.export', 'sso', 'voice',
]);
const METER_KEYS = new Set([
  'api.runs', 'embedding.tokens', 'file.storage_bytes', 'hosted.runs', 'llm.input_tokens',
  'llm.output_tokens', 'rag.retrievals', 'rag.storage_bytes', 'speech.synthesis_characters',
  'speech.transcription_seconds', 'tool.calls',
]);

async function sourceContainsPrimaryKey(
  source: AsyncDatabaseSession,
  table: TransferTable,
  row: Record<string, unknown>,
): Promise<boolean> {
  const predicates = table.primaryKey.map((column, index) => (
    `${quoteTransferIdentifier(column)} = $${index + 1}`
  ));
  const values = table.primaryKey.map((column) => row[column] as DatabaseParameter);
  const matches = await source.query<Record<string, unknown>>({
    text: `
      SELECT ${table.primaryKey.map(quoteTransferIdentifier).join(', ')}
      FROM ${quoteTransferIdentifier(table.name)}
      WHERE ${predicates.join(' AND ')}
      LIMIT 1;
    `,
    values,
  });
  return matches.length === 1;
}

function isExpectedBootstrapRow(tableName: string, row: Record<string, unknown>): boolean {
  if (tableName === 'workspaces') {
    return Number(row.id) === DEFAULT_WORKSPACE_ID && row.slug === DEFAULT_WORKSPACE_SLUG;
  }
  if (tableName === 'workspace_subscriptions') {
    return Number(row.workspace_id) === DEFAULT_WORKSPACE_ID && row.plan_key === 'free';
  }
  if (tableName === 'credit_accounts') {
    return Number(row.workspace_id) === DEFAULT_WORKSPACE_ID;
  }
  if (tableName === 'billing_plans') return PLAN_KEYS.has(String(row.key));
  if (tableName === 'plan_entitlements') {
    return PLAN_KEYS.has(String(row.plan_key)) && FEATURE_KEYS.has(String(row.feature_key));
  }
  if (tableName === 'pricing_versions') return row.key === '2026-08-default';
  if (tableName === 'meter_prices') {
    return row.pricing_version_key === '2026-08-default'
      && METER_KEYS.has(String(row.meter))
      && row.provider === ''
      && row.model === '';
  }
  return false;
}

export async function assertFreshTransferTarget(
  source: AsyncDatabaseSession,
  target: AsyncDatabaseSession,
  tables: readonly TransferTable[],
  batchSize: number,
): Promise<void> {
  for (const table of tables) {
    const targetCount = await countTransferRows(target, table);
    const expectedBootstrapCount = BOOTSTRAP_ROW_COUNTS.get(table.name);
    if (expectedBootstrapCount === undefined) {
      if (targetCount === 0) continue;
      throw new Error(`PostgreSQL target contains business data in table ${table.name}`);
    }
    if (targetCount !== expectedBootstrapCount) {
      throw new Error(`PostgreSQL target bootstrap row count is invalid for table ${table.name}`);
    }

    for (let offset = 0; offset < targetCount; offset += batchSize) {
      const rows = await readTransferRows(target, table, batchSize, offset);
      for (const row of rows) {
        if (!isExpectedBootstrapRow(table.name, row)) {
          throw new Error(`PostgreSQL target contains an unexpected bootstrap row in ${table.name}`);
        }
        if (!await sourceContainsPrimaryKey(source, table, row)) {
          throw new Error(`PostgreSQL target contains an unexpected bootstrap row in ${table.name}`);
        }
      }
    }
  }
}
