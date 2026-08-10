import { createHash } from 'node:crypto';

import { type AsyncDatabaseSession } from '../../db/asyncAdapter';
import { canonicalTransferRow } from './normalization';
import { countTransferRows, readTransferRows } from './tableTransfer';
import { type TableTransferReport, type TransferTable } from './types';

export async function reconcileTransferTable(
  source: AsyncDatabaseSession,
  target: AsyncDatabaseSession,
  table: TransferTable,
  batchSize: number,
): Promise<TableTransferReport> {
  const sourceCount = await countTransferRows(source, table);
  const targetCount = await countTransferRows(target, table);
  if (sourceCount !== targetCount) {
    throw new Error(
      `database transfer row-count mismatch for ${table.name}: source=${sourceCount} target=${targetCount}`,
    );
  }

  const digest = createHash('sha256');
  for (let offset = 0; offset < sourceCount; offset += batchSize) {
    const [sourceRows, targetRows] = await Promise.all([
      readTransferRows(source, table, batchSize, offset),
      readTransferRows(target, table, batchSize, offset),
    ]);
    if (sourceRows.length !== targetRows.length) {
      throw new Error(`database transfer page mismatch for ${table.name} at offset ${offset}`);
    }
    for (let index = 0; index < sourceRows.length; index += 1) {
      const sourceRow = canonicalTransferRow(sourceRows[index] ?? {}, table.columns);
      const targetRow = canonicalTransferRow(targetRows[index] ?? {}, table.columns);
      if (sourceRow !== targetRow) {
        throw new Error(`database transfer row mismatch for ${table.name} at offset ${offset + index}`);
      }
      digest.update(`${sourceRow}\n`);
    }
  }

  return { table: table.name, rows: sourceCount, digest: digest.digest('hex') };
}
