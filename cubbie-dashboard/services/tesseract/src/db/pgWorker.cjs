// Runs in a worker thread. synckit blocks the main thread on each call, so repo.ts can keep
// its synchronous API while queries go to PostgreSQL through the normal async `pg` client.
// One connection: queries are serialized anyway, and BEGIN/COMMIT need the same session.
// Plain CommonJS on purpose: it runs unchanged from src/ (tests, tsx) and dist/ (production).
const pg = require('pg');
const { runAsWorker } = require('synckit');

pg.types.setTypeParser(20, v => Number(v));   // BIGINT (ms timestamps, ids, counts) → number
pg.types.setTypeParser(1700, v => Number(v)); // NUMERIC → number

let client = null;

async function connection() {
  if (client) return client;
  const url = process.env.TESSERACT_PG_URL;
  if (!url) throw new Error('TESSERACT_PG_URL is not set');
  const c = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: false } : undefined });
  c.on('error', () => { client = null; }); // dropped connection → reconnect on next query
  await c.connect();
  client = c;
  return c;
}

runAsWorker(async (op, sql, params) => {
  if (op === 'close') { if (client) await client.end().catch(() => null); client = null; return { rows: [], rowCount: 0 }; }
  const c = await connection();
  const r = await c.query(sql, params || []);
  const last = Array.isArray(r) ? r[r.length - 1] : r; // a multi-statement exec returns an array
  return { rows: (last && last.rows) || [], rowCount: (last && last.rowCount) || 0 };
});
