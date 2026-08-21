FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app/server

FROM base AS production-dependencies
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/index.ts server/worker.ts ./
COPY server/src ./src
RUN rm -rf dist && pnpm build

FROM node:22-alpine AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Primalthrum Server" \
  org.opencontainers.image.version=$VERSION
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=production-dependencies --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --from=build --chown=node:node /app/server/package.json ./package.json
RUN mkdir -p /app/data /app/generated-agents \
  && chown -R node:node /app/data /app/generated-agents
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
