import { createServer } from 'node:http';

const instance = process.env.INSTANCE_NAME;
if (!instance) throw new Error('INSTANCE_NAME is required');

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200).end('ok');
    return;
  }
  if (request.url === '/api/instance') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end(instance);
    return;
  }
  if (request.url === '/api/stream') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write(`${instance}:first\n`);
    setTimeout(() => response.end(`${instance}:last\n`), 4_000);
    return;
  }
  response.writeHead(404).end('not found');
});

server.listen(3000, '0.0.0.0');
