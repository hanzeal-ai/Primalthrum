import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const [url, readyPath] = process.argv.slice(2);
if (!url || !readyPath) throw new Error('stream URL and ready path are required');

const response = await fetch(url);
assert.equal(response.status, 200);
assert.ok(response.body);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let body = '';
let ready = false;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  body += decoder.decode(value, { stream: true });
  if (!ready && body.includes('old:first\n')) {
    writeFileSync(readyPath, 'ready\n');
    ready = true;
  }
}
body += decoder.decode();
assert.equal(body, 'old:first\nold:last\n');
assert.equal(ready, true);
