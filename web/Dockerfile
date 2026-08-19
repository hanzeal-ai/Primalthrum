FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/index.html web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json ./
COPY web/vite.config.ts web/eslint.config.js ./
COPY web/public ./public
COPY web/src ./src
RUN pnpm build

FROM node:22-alpine AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Primalthrum Web" \
  org.opencontainers.image.version=$VERSION
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8080
WORKDIR /app/web
COPY --from=build --chown=node:node /app/web/dist ./dist
COPY --chown=node:node web/productionServer.mjs ./productionServer.mjs
USER node
EXPOSE 8080
CMD ["node", "productionServer.mjs"]
