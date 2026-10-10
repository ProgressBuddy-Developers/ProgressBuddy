'use strict';
// Database adapter. One async API, two backends, zero npm dependencies:
//   - Turso (libSQL) over its HTTP API  -> used when TURSO_DATABASE_URL is set (Vercel)
//   - local SQLite file (node:sqlite)   -> used otherwise (laptop, Render disk, Docker volume)
//
//   await db.get(sql, ...args)   -> first row or undefined
//   await db.all(sql, ...args)   -> array of rows
//   await db.run(sql, ...args)   -> { lastInsertRowid, changes }
//   await db.exec(script)        -> run several statements separated by ;
//   await db.batch([[sql, [args]], ...]) -> all-or-nothing group of statements
//   db.prepare(sql).get/all/run(...args) is kept as a thin async shim
const path = require('node:path'), fs = require('node:fs');

function localBackend(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');          // loaded lazily so Vercel never needs it
  const d = new DatabaseSync(path.join(dataDir, 'progressbuddy.db'));
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const run = (sql, a) => { const r = d.prepare(sql).run(...a); return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) }; };
  return {
    kind: 'sqlite',
    async get(sql, a = []) { return d.prepare(sql).get(...a); },
    async all(sql, a = []) { return d.prepare(sql).all(...a); },
    async run(sql, a = []) { return run(sql, a); },
    async exec(script) { d.exec(script); },
    async batch(list) {
      d.exec('BEGIN');
      try { for (const [sql, a = []] of list) run(sql, a); d.exec('COMMIT'); }
      catch (e) { d.exec('ROLLBACK'); throw e; }
    }
  };
}

function tursoBackend(url, token) {
  const base = String(url).trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('TURSO_DATABASE_URL must look like libsql://your-db.turso.io');
  const enc = v => v === null || v === undefined ? { type: 'null' }
    : typeof v === 'bigint' ? { type: 'integer', value: String(v) }
    : typeof v === 'boolean' ? { type: 'integer', value: v ? '1' : '0' }
    : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : { type: 'text', value: String(v) };
  const dec = c => c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.type === 'float' ? Number(c.value)
    : c.type === 'blob' ? Buffer.from(c.base64 || c.value || '', 'base64') : c.value;
  const exec = (sql, a = []) => ({ type: 'execute', stmt: { sql, args: a.map(enc) } });
  async function pipeline(requests) {
    const r = await fetch(base + '/v2/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] }), signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`Turso HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const out = (await r.json()).results || [];
    return requests.map((_, i) => {
      const x = out[i];
      if (!x) throw new Error('Turso returned no result');
      if (x.type === 'error') throw new Error('Turso: ' + (x.error && x.error.message || 'query failed'));
      return x.response && x.response.result;
    });
  }
  const rows = res => { const cols = res.cols.map(c => c.name); return res.rows.map(r => Object.fromEntries(r.map((c, i) => [cols[i], dec(c)]))); };
  return {
    kind: 'turso',
    async get(sql, a = []) { return rows((await pipeline([exec(sql, a)]))[0])[0]; },
    async all(sql, a = []) { return rows((await pipeline([exec(sql, a)]))[0]); },
    async run(sql, a = []) {
      const r = (await pipeline([exec(sql, a)]))[0];
      return { lastInsertRowid: r.last_insert_rowid == null ? 0 : Number(r.last_insert_rowid), changes: Number(r.affected_row_count || 0) };
    },
    async exec(script) {
      const stmts = script.split(';').map(s => s.trim()).filter(Boolean);
      if (stmts.length) await pipeline(stmts.map(s => exec(s)));
    },
    // BEGIN ... COMMIT in one request; if any statement fails the stream closes with the transaction open, which rolls it back.
    async batch(list) { await pipeline([exec('BEGIN'), ...list.map(([sql, a]) => exec(sql, a || [])), exec('COMMIT')]); }
  };
}

function openDb({ dataDir }) {
  const url = process.env.TURSO_DATABASE_URL;
  let b;
  if (url) {
    if (!process.env.TURSO_AUTH_TOKEN) throw new Error('TURSO_AUTH_TOKEN is missing');
    b = tursoBackend(url, process.env.TURSO_AUTH_TOKEN.trim());
  } else if (process.env.VERCEL) {
    throw new Error('On Vercel you must set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (the local SQLite file cannot persist there).');
  } else b = localBackend(dataDir);
  b.prepare = sql => ({ get: (...a) => b.get(sql, a), all: (...a) => b.all(sql, a), run: (...a) => b.run(sql, a) });
  return b;
}

module.exports = { openDb };
