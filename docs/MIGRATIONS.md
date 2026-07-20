# Database Migrations

Server schema changes are applied through ordered TypeScript migrations in `server/src/db/migrations.ts`.

Run migrations against the default local database:

```bash
cd server
TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register src/db/migrate.ts
```

Run migrations against a specific SQLite file:

```bash
cd server
TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register src/db/migrate.ts /absolute/path/platform.sqlite
```

The runner records applied migration IDs in `schema_migrations` and can be run repeatedly.
