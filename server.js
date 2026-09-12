'use strict';

/**
 * Sales Hiring Tracker
 * Shared candidate tracker for B2C inside sales hiring.
 *
 * Storage: Postgres when DATABASE_URL is set (Railway), otherwise a JSON file
 * under DATA_DIR so the app still runs locally with no database.
 *
 * Env vars
 *   DATABASE_URL   Postgres connection string (Railway provides this)
 *   APP_PASSCODE   Shared passcode required to read or write. If unset, the
 *                  app runs open and says so on /api/health.
 *   DATA_DIR       Directory for the JSON fallback store (default ./data)
 *   PORT           Listen port (Railway provides this)
 *   DATABASE_SSL   Set to "true" to force TLS on the Postgres connection
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PASSCODE = (process.env.APP_PASSCODE || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

const BUILD = {
  startedAt: new Date().toISOString(),
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || 'local'
};

/* ------------------------------------------------------------------ */
/* Storage layer                                                       */
/* ------------------------------------------------------------------ */

const store = {
  kind: DATABASE_URL ? 'postgres' : 'file',
  ready: false,
  error: null
};

let pool = null;

function sslConfig() {
  if (String(process.env.DATABASE_SSL || '').toLowerCase() === 'true') {
    return { rejectUnauthorized: false };
  }
  if (/sslmode=require/i.test(DATABASE_URL)) return { rejectUnauthorized: false };
  return false;
}

async function initPostgres() {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: sslConfig(), max: 5 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id           BIGSERIAL PRIMARY KEY,
      ts           BIGINT NOT NULL,
      candidate_id TEXT,
      candidate    TEXT,
      actor        TEXT,
      action       TEXT,
      detail       TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts DESC)`);
}

function filePaths() {
  return {
    candidates: path.join(DATA_DIR, 'candidates.json'),
    events: path.join(DATA_DIR, 'events.json')
  };
}

function readJsonFile(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('Could not read ' + p + ': ' + e.message);
    return fallback;
  }
}

function writeJsonFile(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

async function initStore() {
  try {
    if (store.kind === 'postgres') {
      await initPostgres();
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    store.ready = true;
    console.log('Storage ready: ' + store.kind);
  } catch (e) {
    store.error = e.message;
    console.error('Storage init failed: ' + e.message);
  }
}

async function listCandidates() {
  if (store.kind === 'postgres') {
    const r = await pool.query('SELECT data FROM candidates ORDER BY updated_at DESC');
    return r.rows.map(function (row) { return row.data; });
  }
  const list = readJsonFile(filePaths().candidates, []);
  return list.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
}

async function upsertCandidate(record) {
  if (store.kind === 'postgres') {
    await pool.query(
      `INSERT INTO candidates (id, data, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [record.id, JSON.stringify(record), record.updatedAt || Date.now()]
    );
    return record;
  }
  const p = filePaths().candidates;
  const list = readJsonFile(p, []);
  const idx = list.findIndex(function (c) { return c.id === record.id; });
  if (idx >= 0) list[idx] = record; else list.push(record);
  writeJsonFile(p, list);
  return record;
}

async function getCandidate(id) {
  if (store.kind === 'postgres') {
    const r = await pool.query('SELECT data FROM candidates WHERE id = $1', [id]);
    return r.rows.length ? r.rows[0].data : null;
  }
  const list = readJsonFile(filePaths().candidates, []);
  return list.find(function (c) { return c.id === id; }) || null;
}

async function deleteCandidate(id) {
  if (store.kind === 'postgres') {
    await pool.query('DELETE FROM candidates WHERE id = $1', [id]);
    return;
  }
  const p = filePaths().candidates;
  const list = readJsonFile(p, []).filter(function (c) { return c.id !== id; });
  writeJsonFile(p, list);
}

async function logEvent(ev) {
  const row = {
    ts: Date.now(),
    candidate_id: ev.candidateId || null,
    candidate: ev.candidate || null,
    actor: ev.actor || 'Someone',
    action: ev.action || 'updated',
    detail: ev.detail || null
  };
  try {
    if (store.kind === 'postgres') {
      await pool.query(
        'INSERT INTO events (ts, candidate_id, candidate, actor, action, detail) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.ts, row.candidate_id, row.candidate, row.actor, row.action, row.detail]
      );
      // Keep the feed bounded.
      await pool.query('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY ts DESC LIMIT 500)');
    } else {
      const p = filePaths().events;
      const list = readJsonFile(p, []);
      list.unshift(row);
      writeJsonFile(p, list.slice(0, 500));
    }
  } catch (e) {
    console.error('Could not log event: ' + e.message);
  }
}

async function listEvents(limit) {
  const n = Math.min(Number(limit) || 60, 200);
  if (store.kind === 'postgres') {
    const r = await pool.query('SELECT ts, candidate_id, candidate, actor, action, detail FROM events ORDER BY ts DESC LIMIT $1', [n]);
    return r.rows;
  }
  return readJsonFile(filePaths().events, []).slice(0, n);
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function checkPasscode(req) {
  if (!PASSCODE) return true;
  const supplied = String(req.get('x-passcode') || req.query.passcode || '').trim();
  return supplied.length > 0 && timingSafeEqual(supplied, PASSCODE);
}

app.get('/api/health', function (req, res) {
  res.json({
    ok: true,
    storage: store.kind,
    storageReady: store.ready,
    storageError: store.error,
    passcodeRequired: Boolean(PASSCODE),
    build: BUILD
  });
});

app.post('/api/login', function (req, res) {
  const supplied = String((req.body && req.body.passcode) || '').trim();
  if (!PASSCODE) return res.json({ ok: true, passcodeRequired: false });
  if (supplied && timingSafeEqual(supplied, PASSCODE)) return res.json({ ok: true, passcodeRequired: true });
  return res.status(401).json({ ok: false, error: 'Incorrect passcode' });
});

// Everything below needs the passcode.
app.use('/api', function (req, res, next) {
  if (!store.ready) {
    return res.status(503).json({ error: 'Storage not ready' + (store.error ? ': ' + store.error : '') });
  }
  if (!checkPasscode(req)) return res.status(401).json({ error: 'Passcode required' });
  next();
});

app.get('/api/candidates', async function (req, res) {
  try {
    res.json({ candidates: await listCandidates() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/events', async function (req, res) {
  try {
    res.json({ events: await listEvents(req.query.limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function sanitiseRecord(body, existing) {
  const now = Date.now();
  const id = (existing && existing.id) || String(body.id || '').trim() ||
    ('c_' + now + '_' + Math.random().toString(36).slice(2, 8));
  const rec = {
    id: id,
    name: String(body.name || '').trim(),
    position: String(body.position || '').trim(),
    email: String(body.email || '').trim(),
    phone: String(body.phone || '').trim(),
    source: String(body.source || '').trim(),
    stage: String(body.stage || 'round1').trim(),
    rounds: (body.rounds && typeof body.rounds === 'object') ? body.rounds : {},
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
    updatedBy: String(body.updatedBy || '').trim() || (existing && existing.updatedBy) || ''
  };
  return rec;
}

app.put('/api/candidates/:id', async function (req, res) {
  try {
    const body = req.body || {};
    if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Candidate name is required' });
    const existing = await getCandidate(req.params.id);
    const rec = sanitiseRecord(Object.assign({}, body, { id: req.params.id }), existing);
    await upsertCandidate(rec);
    await logEvent({
      candidateId: rec.id,
      candidate: rec.name,
      actor: rec.updatedBy || 'Someone',
      action: existing ? 'updated' : 'added',
      detail: String(body.eventDetail || '').trim() || null
    });
    res.json({ candidate: rec });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/candidates', async function (req, res) {
  try {
    const body = req.body || {};
    if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Candidate name is required' });
    const rec = sanitiseRecord(body, null);
    await upsertCandidate(rec);
    await logEvent({
      candidateId: rec.id,
      candidate: rec.name,
      actor: rec.updatedBy || 'Someone',
      action: 'added',
      detail: String(body.eventDetail || '').trim() || null
    });
    res.status(201).json({ candidate: rec });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/candidates/:id', async function (req, res) {
  try {
    const existing = await getCandidate(req.params.id);
    await deleteCandidate(req.params.id);
    if (existing) {
      await logEvent({
        candidateId: existing.id,
        candidate: existing.name,
        actor: String(req.query.by || '').trim() || 'Someone',
        action: 'deleted'
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/import', async function (req, res) {
  try {
    const incoming = (req.body && req.body.candidates) || [];
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected an array of candidates' });
    let added = 0, updated = 0, skipped = 0;
    for (const raw of incoming) {
      if (!raw || !String(raw.name || '').trim()) { skipped++; continue; }
      const existing = raw.id ? await getCandidate(String(raw.id)) : null;
      const rec = sanitiseRecord(raw, existing);
      if (raw.createdAt) rec.createdAt = raw.createdAt;
      if (raw.updatedAt) rec.updatedAt = raw.updatedAt;
      await upsertCandidate(rec);
      if (existing) updated++; else added++;
    }
    await logEvent({
      actor: String((req.body && req.body.by) || '').trim() || 'Someone',
      action: 'imported',
      detail: added + ' added, ' + updated + ' updated'
    });
    res.json({ added: added, updated: updated, skipped: skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initStore().then(function () {
  app.listen(PORT, function () {
    console.log('Sales hiring tracker listening on ' + PORT + ' (storage: ' + store.kind + ')');
    if (!PASSCODE) console.log('WARNING: APP_PASSCODE is not set, the app is open to anyone with the link.');
  });
});
