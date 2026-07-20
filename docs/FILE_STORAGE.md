# File Storage

Primalthrum stores document metadata in SQLite and document file content through a `DocumentFileStorage` provider.

## Local Provider

The default server provider is `LocalDocumentStorage` in `server/src/services/fileStorage.ts`.

By default, files are stored under:

```text
../data/documents
```

Set `DOCUMENT_STORAGE_DIR` when starting the server to place files on a durable volume outside the source tree:

```bash
DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents pnpm start
```

Document records store only a `storageRef`, such as `local://documents/...`; API responses never include the original file content after registration.

## Provider Contract

Storage providers implement:

```ts
interface DocumentFileStorage {
  save(input: SaveDocumentFileInput): StoredDocumentFile
  read(storageRef: string): string
  delete(storageRef: string): void
}
```

Future object storage providers should keep the same `storageRef` pattern and avoid coupling document metadata to local filesystem paths.
