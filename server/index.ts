import { createApp } from './src/app';

const port = Number(process.env.PORT ?? 3000);
const agentBaseUrl = process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:8000';
const documentStorageDir = process.env.DOCUMENT_STORAGE_DIR;

const app = createApp({ agentBaseUrl, documentStorageDir });

app.listen(port, () => {
  console.log(`Primalthrum Node server listening on http://127.0.0.1:${port}`);
  console.log(`Agent upstream: ${agentBaseUrl}`);
});
