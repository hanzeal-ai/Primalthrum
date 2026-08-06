import { createDocumentFileStorage } from '../services/documentStorageConfiguration';

async function main(): Promise<void> {
  const storage = createDocumentFileStorage(process.env);
  await storage.healthCheck();
  const saved = await storage.save({
    workspaceId: 9001,
    agentId: 9002,
    documentId: 9003,
    filename: 'object-storage-smoke.txt',
    content: 'primalthrum object storage smoke',
  });
  const content = await storage.read(saved.storageRef);
  if (content !== 'primalthrum object storage smoke') {
    throw new Error('object storage smoke read returned unexpected content');
  }
  await storage.delete(saved.storageRef);
  try {
    await storage.read(saved.storageRef);
    throw new Error('object storage smoke delete did not hide the current object version');
  } catch (error) {
    if (error instanceof Error && error.message.includes('did not hide')) throw error;
    if (!(error instanceof Error) || !error.message.includes('status 404')) {
      throw new Error('object storage smoke delete verification failed');
    }
  }
  process.stdout.write(`object storage smoke passed: ${saved.storageRef}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'object storage smoke failed'}\n`);
  process.exitCode = 1;
});
