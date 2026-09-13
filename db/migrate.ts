import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is not defined.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
  });

  const client = await pool.connect();

  try {
    console.log('Connecting to database and verifying schema_migrations table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    console.log(`Found ${files.length} migration file(s).`);

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT filename FROM schema_migrations WHERE filename = $1',
        [file]
      );

      if (rows.length > 0) {
        console.log(`- Skipping ${file} (already applied)`);
        continue;
      }

      console.log(`Applying ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`✓ Successfully applied ${file}`);
      } catch (migrationError) {
        await client.query('ROLLBACK');
        console.error(`✗ Error applying ${file}:`, migrationError);
        throw migrationError;
      }
    }

    console.log('All migrations executed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
