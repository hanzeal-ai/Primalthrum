# File Storage

Primalthrum stores document metadata in the application database and document
content through a `DocumentFileStorage` provider. Development supports local
files; production startup requires an S3-compatible provider.

## Provider Selection

| Variable | Development | Production |
| --- | --- | --- |
| `DOCUMENT_STORAGE_PROVIDER` | `local` or `s3` | must be `s3` |
| `DOCUMENT_STORAGE_DIR` | local provider root | unused |
| `OBJECT_STORAGE_ENDPOINT` | S3-compatible origin | HTTPS origin required |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | S3 access key | secret-manager value |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | S3 secret | secret-manager value |
| `OBJECT_STORAGE_SESSION_TOKEN` | optional | optional short-lived credential |
| `OBJECT_STORAGE_BUCKET` | bucket name | private production bucket |
| `OBJECT_STORAGE_REGION` | signing region | signing region |
| `OBJECT_STORAGE_PREFIX` | defaults to `primalthrum` | unique environment prefix |
| `OBJECT_STORAGE_TIMEOUT_MS` | defaults to `10000` | 250 to 60000 milliseconds |

The S3 provider uses path-style AWS Signature Version 4 requests and works with
AWS S3-compatible services such as MinIO. Its credentials are server-only.

## Local Development

The local provider defaults to `../data/documents`:

```bash
DOCUMENT_STORAGE_PROVIDER=local \
DOCUMENT_STORAGE_DIR=/var/lib/primalthrum/documents \
pnpm --dir server start
```

Local references start with `local://`. Paths are resolved inside the configured
root and cannot escape it. Production rejects this provider at startup because
an application-node filesystem is not a multi-instance durability boundary.

## S3-Compatible Production

```bash
NODE_ENV=production \
DOCUMENT_STORAGE_PROVIDER=s3 \
OBJECT_STORAGE_ENDPOINT=https://s3.example.com \
OBJECT_STORAGE_ACCESS_KEY_ID="$OBJECT_STORAGE_ACCESS_KEY_ID" \
OBJECT_STORAGE_SECRET_ACCESS_KEY="$OBJECT_STORAGE_SECRET_ACCESS_KEY" \
OBJECT_STORAGE_BUCKET=primalthrum-documents \
OBJECT_STORAGE_REGION=us-east-1 \
OBJECT_STORAGE_PREFIX=production \
pnpm --dir server start
```

References use `s3://bucket/prefix/...`. Every read and delete validates the
configured bucket and prefix before transport, so a reference from another
environment or tenant bucket is rejected. S3 response bodies are not copied into
application errors. `/ready` checks bucket access and removes an unhealthy server
from traffic.

## Bucket Policy And Lifecycle

Before production traffic:

1. Block all public access and grant the server only bucket health, object read,
   write, and delete permissions for the configured prefix.
2. Enable server-side encryption and TLS. Use short-lived workload credentials
   where the provider supports them.
3. Enable bucket versioning. An application delete then creates a delete marker,
   permitting controlled recovery of an earlier version.
4. Replicate or back up object versions to a separate failure domain.
5. Apply expiration only to noncurrent versions after the longest contractual,
   statutory, and backup recovery period has elapsed.

Application legal holds stop retention and account-deletion object requests, but
they cannot override a bucket administrator or an external lifecycle rule. Where
regulated immutability is required, configure provider-native Object Lock or a
separate immutable archive and include release in the legal-hold runbook.

## Provider Contract

Providers implement asynchronous-capable storage operations:

```ts
interface DocumentFileStorage {
  save(input: SaveDocumentFileInput): StoredDocumentFile | Promise<StoredDocumentFile>
  read(storageRef: string): string | Promise<string>
  delete(storageRef: string): void | Promise<void>
  healthCheck(): void | Promise<void>
}
```

Upload completion waits for durable storage before metadata is marked ready.
RAG indexing and privacy exports wait for reads. Retention and account deletion
wait for deletes and preserve existing retry/failure evidence when transport fails.

Storage references are provider-specific. Changing provider does not rewrite
existing `local://` records; migrate both content and references in a controlled
maintenance window before switching a deployment that already has documents.

## Verification

Docker is required for the real S3-compatible smoke test:

```bash
scripts/object-storage-smoke.sh
```

The script starts fixed MinIO images on an isolated network, enables bucket
versioning, verifies health/write/read/delete through the production provider,
asserts the object version and delete marker, and removes all temporary resources.

Every upload is also parsed and malware-scanned before credit reservation,
metadata creation, or persistence. See
[Upload And Provider Egress Security](UPLOAD_EGRESS_SECURITY.md).
