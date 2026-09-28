require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log('-> applying', file);
    await pool.query(sql);
    console.log('   ok');
  }

  await pool.end();
  console.log('migrations done');
})().catch(e => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
