import fs from 'fs';
import path from 'path';
import { getMigrationPgPool } from './client';

export async function runMigrations(): Promise<void> {
  const pool = getMigrationPgPool();
  const migrationsDir = path.join(__dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    // The ledger is created before individual migration transactions so a
    // failed migration is never recorded as completed.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Prevent concurrent deploys from applying the same migration.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['knowledge-platform:migrations']);
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (alreadyApplied.rowCount) continue;

      const migrationSql = fs.readFileSync(filePath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(migrationSql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['knowledge-platform:migrations']).catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('SQL Migrations completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
