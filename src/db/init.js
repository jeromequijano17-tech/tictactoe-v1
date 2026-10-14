import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool } from './pool.js';

try {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map((item) => item.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  console.log('Database schema and seed data are ready.');
} catch (error) {
  console.error('Database initialization failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}