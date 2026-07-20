import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export interface SaveDocumentFileInput {
  workspaceId: number;
  agentId: number;
  documentId: number;
  filename: string;
  content: string;
}

export interface StoredDocumentFile {
  storageRef: string;
  absolutePath: string;
}

export interface DocumentFileStorage {
  save(input: SaveDocumentFileInput): StoredDocumentFile;
  read(storageRef: string): string;
  delete(storageRef: string): void;
}

const STORAGE_REF_PREFIX = 'local://documents/';

export class LocalDocumentStorage implements DocumentFileStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    mkdirSync(this.rootDir, { recursive: true });
  }

  save(input: SaveDocumentFileInput): StoredDocumentFile {
    const relativePath = join(
      'workspaces',
      String(input.workspaceId),
      'agents',
      String(input.agentId),
      'documents',
      String(input.documentId),
      safeFilename(input.filename),
    );
    const absolutePath = this.resolveInsideRoot(relativePath);

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, input.content, 'utf8');

    return {
      storageRef: `${STORAGE_REF_PREFIX}${relativePath.split('/').join('/')}`,
      absolutePath,
    };
  }

  read(storageRef: string): string {
    return readFileSync(this.pathFromRef(storageRef), 'utf8');
  }

  delete(storageRef: string): void {
    rmSync(this.pathFromRef(storageRef), { force: true });
  }

  private pathFromRef(storageRef: string): string {
    if (!storageRef.startsWith(STORAGE_REF_PREFIX)) {
      throw new Error('unsupported document storage ref');
    }

    return this.resolveInsideRoot(storageRef.slice(STORAGE_REF_PREFIX.length));
  }

  private resolveInsideRoot(relativePath: string): string {
    const absolutePath = resolve(this.rootDir, relativePath);
    if (relative(this.rootDir, absolutePath).startsWith('..')) {
      throw new Error('document path escaped storage root');
    }
    return absolutePath;
  }
}

function safeFilename(filename: string): string {
  const candidate = basename(filename.trim()).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return candidate || 'document.txt';
}
