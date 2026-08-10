import assert from 'node:assert/strict';
import { test } from 'node:test';

import { postgresProcessEnvironment } from '../src/services/postgres-backup/process';

test('PostgreSQL recovery process environment removes URLs from arguments and preserves libpq settings', () => {
  const environment = postgresProcessEnvironment(
    'postgresql://backup%20user:secret%2Fvalue@db.example.com:6432/primalthrum?sslmode=verify-full',
    { DATABASE_URL: 'must-not-leak', PATH: '/usr/bin' },
  );

  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.PGHOST, 'db.example.com');
  assert.equal(environment.PGPORT, '6432');
  assert.equal(environment.PGUSER, 'backup user');
  assert.equal(environment.PGPASSWORD, 'secret/value');
  assert.equal(environment.PGDATABASE, 'primalthrum');
  assert.equal(environment.PGSSLMODE, 'verify-full');
  assert.equal(environment.PATH, '/usr/bin');
});

test('PostgreSQL recovery process environment rejects incomplete or unsafe connection settings', () => {
  assert.throws(() => postgresProcessEnvironment('not-a-url'), /connection string is invalid/);
  assert.throws(
    () => postgresProcessEnvironment('postgresql://db.example.com/primalthrum'),
    /connection string is incomplete/,
  );
  assert.throws(
    () => postgresProcessEnvironment('postgresql://user@db.example.com/primalthrum?sslmode=unknown'),
    /sslmode is invalid/,
  );
});
