# Upload And Provider Egress Security

## Upload Boundary

Document uploads accept bounded UTF-8 text formats only. The Server validates a
base filename, extension/MIME agreement, strict Base64, byte size, UTF-8, null
bytes, and JSON syntax before scanning. Malware inspection then runs before usage
reservation, document metadata creation, or file persistence.

Development uses an explicit EICAR signature scanner so local and CI workflows do
not silently skip the security boundary. Production is fail-closed: when
`NODE_ENV=production`, `CLAMAV_HOST` is required during Server startup.

```bash
export CLAMAV_HOST=clamav
export CLAMAV_PORT=3310
export CLAMAV_TIMEOUT_MS=5000
```

The ClamAV adapter uses the `INSTREAM` protocol with bounded 64 KiB chunks and a
bounded timeout. Keep ClamAV on the private service network and do not publish its
TCP port. Threats return HTTP 422 with `DOCUMENT_THREAT_DETECTED`. Timeout,
connection, empty-result, and scanner-error paths return HTTP 503 with
`DOCUMENT_SCAN_UNAVAILABLE`. Both fail before storage and billing.

Migration 029 records immutable scan evidence in
`document_upload_security_events`. Evidence contains Workspace, Agent, and actor
IDs; SHA-256 hashes of the normalized filename and original bytes; MIME and byte
size; scanner; status; and bounded threat metadata. It never stores the filename,
document content, Base64 payload, Provider secret, or Session token.
The repository supports parameterized asynchronous SQLite and PostgreSQL writes,
normalizes timestamps at the boundary, and scopes every read by Workspace. Both
database providers enforce evidence immutability with a database trigger.

## Provider Egress Boundary

Provider `baseUrl` values are normalized before persistence by the Node Server and
validated again immediately before LLM, Embedding, STT, or TTS transport by the
Python Agent. The policy requires HTTPS and rejects URL credentials, queries,
fragments, localhost/private/metadata hostnames, private or reserved IP literals,
IPv4-mapped IPv6, and DNS answers containing any private or reserved address.
Redirect following and environment proxy discovery are disabled in Provider HTTP
clients.

DNS can change between preflight and connection. Production must therefore also
enforce an egress firewall or service-mesh allowlist for approved Provider hosts
and block loopback, RFC1918, link-local, cloud metadata, multicast, and internal
service ranges. Application validation and infrastructure egress policy are
independent required controls.

## Verification

```bash
cd server
node --test --test-concurrency=1 --require ts-node/register \
  tests/providerEndpointPolicy.test.ts tests/uploadSecurity.test.ts \
  tests/asyncDocumentUploadSecurityRepository.test.ts

cd ../agent
./.venv/bin/python -m unittest discover -s tests -v
```

Before release, repeat the EICAR and scanner-outage checks against the deployed
ClamAV instance and confirm the egress layer blocks a controlled private-address
Provider target.
