import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Defina DATABASE_URL antes de executar npm run migrate.');
}

const pool = new Pool({ connectionString });
const migrationsUrl = new URL('../src/migrations/', import.meta.url);
const migrations = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort();
const client = await pool.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const filename of migrations) {
    const migration = filename.replace(/\.sql$/, '');
    await client.query('BEGIN');
    try {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration]);
      if (applied.rowCount === 0) {
        const sql = await readFile(new URL(filename, migrationsUrl), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration]);
        console.log(`Migração ${migration} aplicada.`);
      } else {
        console.log(`Migração ${migration} já aplicada.`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
} catch (error) {
  throw error;
} finally {
  client.release();
  await pool.end();
}