import 'dotenv/config';
import { DataSource } from 'typeorm';
import { entities, migrations } from './data-source-definitions';

function createDataSource(): DataSource {
  // Prefer a direct (non-pooled) connection for migrations: the advisory lock in
  // migrate.ts is session-scoped and won't hold over PgBouncer, so overlapping
  // deploys could still deadlock if migrations ran through the pool. Fall back to
  // DATABASE_URL only for local/self-hosted, where it's already a direct
  // connection (no PgBouncer in front).
  const databaseUrl =
    process.env['MIGRATION_DATABASE_URL'] ??
    process.env['DATABASE_UNPOOLED_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://myuser:mypassword@localhost:5432/mydatabase';

  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    // Explicit arrays (not globs): the pre-deploy `node dist/database/migrate.js`
    // must run exactly the committed migration set. A dist glob would also pick up
    // stale compiled .js from deleted migrations (deleteOutDir is off), so this
    // stays in lockstep with the boot path in database.module.
    entities,
    migrations,
  });
}

export default createDataSource();
