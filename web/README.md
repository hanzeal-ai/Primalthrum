# Primalthrum Web

React + TypeScript + Vite console for the Primalthrum stream API.

```bash
pnpm install
pnpm dev
pnpm lint
pnpm build
```

The Vite dev server proxies `/api` to `http://localhost:3000` by default. Override it for containers or remote server development:

```bash
VITE_SERVER_PROXY_TARGET=http://server:3000 pnpm dev
```
