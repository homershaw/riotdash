#!/usr/bin/env node
'use strict';
// MQTT Dash: MQTT broker (TCP + WebSocket) + drag-and-drop dashboard server. No dependencies.

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Broker, hashPassword } = require('./broker');
const { acceptUpgrade } = require('./websocket');
const { Store, safeId } = require('./store');
const updater = require('./updater');

const ROOT = path.resolve(__dirname, '..');

// ---------- CLI helpers ----------
if (process.argv[2] === 'hash-password') {
  const pw = process.argv[3];
  if (!pw) { console.error('usage: node server/index.js hash-password <password>'); process.exit(1); }
  console.log(hashPassword(pw));
  process.exit(0);
}

// ---------- supervisor ----------
// The process you start is a tiny supervisor; the real server runs as a child so it can restart
// itself after an in-app update (exit code 75) without systemd or a terminal noticing.
const CLI = ['set-admin-password', 'update'].includes(process.argv[2]);
if (!process.env.MQTTDASH_WORKER && !CLI) {
  const { spawn } = require('child_process');
  let child, stopping = false;
  const start = () => {
    child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, MQTTDASH_WORKER: '1' } });
    child.on('exit', (code, signal) => {
      if (stopping) process.exit(code ?? 0);
      if (code === 75) { console.log('\n— restarting MQTT Dash after update —\n'); setTimeout(start, 300); return; }
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; if (child) child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig); });
  start();
  return;
}

// ---------- config ----------
const DEFAULTS = {
  http: { host: '0.0.0.0', port: 8080, basicAuth: null },
  mqtt: { enabled: true, host: '0.0.0.0', port: 1883, wsPath: '/mqtt' },
  auth: { enabled: false, users: [] },
  dataDir: './data',
  historyPoints: 2000,
  sysTopics: true,
  updates: { github: 'homershaw/riotdash', channel: 'stable' },
};
const configPath = process.env.MQTTDASH_CONFIG || path.join(ROOT, 'config.json');
// First run: create config.json from the example so you have something to edit. Updates never touch it.
if (!fs.existsSync(configPath) && !process.env.MQTTDASH_CONFIG && fs.existsSync(path.join(ROOT, 'config.example.json'))) {
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), configPath);
}
let fileCfg = {};
if (fs.existsSync(configPath)) fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const config = {
  ...DEFAULTS, ...fileCfg,
  http: { ...DEFAULTS.http, ...(fileCfg.http || {}) },
  mqtt: { ...DEFAULTS.mqtt, ...(fileCfg.mqtt || {}) },
  auth: { ...DEFAULTS.auth, ...(fileCfg.auth || {}) },
  updates: { ...DEFAULTS.updates, ...(fileCfg.updates || {}) },
};
if (process.env.HTTP_PORT) config.http.port = Number(process.env.HTTP_PORT);
if (process.env.MQTT_PORT) config.mqtt.port = Number(process.env.MQTT_PORT);
const dataDir = path.resolve(path.dirname(configPath), process.env.MQTTDASH_DATA || config.dataDir);

// ---------- CLI: admin password & offline update ----------
if (process.argv[2] === 'set-admin-password') {
  fs.mkdirSync(dataDir, { recursive: true });
  try { updater.setAdminPassword(dataDir, process.argv[3]); console.log('Admin password saved.'); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }
}
if (process.argv[2] === 'update') {
  const file = process.argv[3];
  if (!file) { console.error('usage: node server/index.js update <mqtt-dash.tar.gz>'); process.exit(1); }
  try {
    const r = updater.applyUpdate(ROOT, fs.readFileSync(file));
    console.log(`Updated ${r.from} → ${r.to}. Restart MQTT Dash to run the new version (backup: .backups/${r.backupId}).`);
    process.exit(0);
  } catch (e) { console.error('Update failed:', e.message); process.exit(1); }
}

// ---------- core ----------
const store = new Store(dataDir, { historyPoints: config.historyPoints });
const broker = new Broker(config);
broker.retained = store.loadRetained();
for (const [t, m] of broker.retained) store.record(t, m.payload, m.ts || Date.now(), true);

broker.on('message', (m) => store.record(m.topic, m.payload, m.ts, m.retain));
let retainedDirty = false;
broker.on('retainedChanged', () => { retainedDirty = true; });
setInterval(() => {
  if (retainedDirty) { retainedDirty = false; store.saveRetained(broker.retained); }
  store.flushHistory();
}, 5000).unref();
if (config.sysTopics) broker.startSysTopics();

// Seed a demo dashboard the first time
if (store.listDashboards().length === 0) {
  store.saveDashboard('plant-demo', require('./demo-dashboard'));
}

// ---------- HTTP ----------
const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBodyBuf(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readBody = async (req, limit) => (await readBodyBuf(req, limit)).toString('utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function restartSoon() { setTimeout(() => { saveState(); process.exit(75); }, 400); }

let checkCache = { at: 0, data: null };
async function checkForUpdate(force) {
  if (!force && checkCache.data && Date.now() - checkCache.at < 30 * 60 * 1000) return checkCache.data;
  const u = config.updates;
  let data;
  try { data = await updater.checkGithub(u.github, u.channel, updater.appVersion(ROOT)); }
  catch (e) { data = { current: updater.appVersion(ROOT), available: false, error: e.message }; }
  data.repo = u.github; data.channel = u.channel;
  checkCache = { at: Date.now(), data };
  return data;
}

async function handleUpdateApi(req, res, parts, url) {
  const sub = parts[2];
  if (sub === 'check' && req.method === 'GET') {
    if (!config.updates.github) return json(res, 200, { available: false, disabled: true });
    return json(res, 200, await checkForUpdate(url.searchParams.get('force') === '1'));
  }
  if (sub === 'status' && req.method === 'GET') {
    return json(res, 200, {
      version: updater.appVersion(ROOT), adminSet: updater.adminIsSet(dataDir), canSetAdmin: updater.isLocalRequest(req),
      writable: updater.isWritable(ROOT), supervised: !!process.env.MQTTDASH_WORKER, backups: updater.listBackups(ROOT),
    });
  }
  if (sub === 'admin' && req.method === 'POST') {
    if (updater.adminIsSet(dataDir)) return json(res, 409, { error: 'Admin password is already set' });
    if (!updater.isLocalRequest(req)) return json(res, 403, { error: 'Create the admin password from your local network, not through Cloudflare' });
    const { password } = JSON.parse((await readBody(req)) || '{}');
    try { updater.setAdminPassword(dataDir, password); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // everything below needs the admin password
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!updater.checkAdminPassword(dataDir, req.headers['x-admin-password'])) { await sleep(800); return json(res, 401, { error: 'Wrong admin password' }); }
  if (!updater.isWritable(ROOT)) return json(res, 500, { error: `The app folder (${ROOT}) is not writable by the server. Re-run deploy/install.sh from this version.` });
  try {
    if (sub === 'github') {
      const c = await checkForUpdate(true);
      if (c.error) throw new Error(c.error);
      if (!c.available) return json(res, 409, { error: `Already up to date (v${c.current})` });
      console.log(`[update] downloading ${c.refName} from github.com/${c.repo}`);
      const r = updater.applyUpdate(ROOT, await updater.downloadGithub(c.url));
      console.log(`[update] ${r.from} → ${r.to} (${r.files} files, backup ${r.backupId})`);
      json(res, 200, { ok: true, ...r, notes: r.notes || c.notes });
      return restartSoon();
    }
    if (!sub) {
      const r = updater.applyUpdate(ROOT, await readBodyBuf(req, 50 * 1024 * 1024));
      console.log(`[update] ${r.from} → ${r.to} (${r.files} files, backup ${r.backupId})`);
      json(res, 200, { ok: true, ...r });
      return restartSoon();
    }
    if (sub === 'rollback') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      const r = updater.rollback(ROOT, id);
      console.log(`[update] rolled back ${r.from} → ${r.to}`);
      json(res, 200, { ok: true, ...r });
      return restartSoon();
    }
    if (sub === 'restart') { json(res, 200, { ok: true }); return restartSoon(); }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  return json(res, 404, { error: 'not found' });
}

function checkBasicAuth(req) {
  const ba = config.http.basicAuth;
  if (!ba || !ba.username) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const p = rest.join(':');
  const a = crypto.createHash('sha256').update(`${u}:${p}`).digest();
  const b = crypto.createHash('sha256').update(`${ba.username}:${ba.password}`).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'update') return handleUpdateApi(req, res, parts, url);
  if (parts[1] === 'info' && method === 'GET') {
    return json(res, 200, {
      name: 'MQTT Dash', version: updater.appVersion(ROOT),
      clients: broker.sessions.size, retained: broker.retained.size, messagesIn: broker.stats.messagesIn,
      uptime: Math.round((Date.now() - broker.stats.started) / 1000),
      mqttPort: config.mqtt.port, wsPath: config.mqtt.wsPath, authEnabled: !!config.auth.enabled,
    });
  }
  if (parts[1] === 'topics' && method === 'GET') return json(res, 200, store.listTopics().map((t) => ({ ...t, retained: broker.retained.has(t.topic) })));
  if (parts[1] === 'history' && method === 'GET') {
    const topic = url.searchParams.get('topic');
    if (!topic) return json(res, 400, { error: 'topic required' });
    return json(res, 200, store.getHistory(topic, Number(url.searchParams.get('since') || 0)));
  }
  if (parts[1] === 'clients' && method === 'GET') {
    return json(res, 200, [...broker.sessions.values()].map((s) => ({
      clientId: s.clientId, username: s.username || null, transport: s.transport, remote: s.remote, connectedAt: s.connectedAt, keepalive: s.keepalive, messagesIn: s.msgsIn, subscriptions: [...s.subs.keys()],
    })));
  }
  if (parts[1] === 'dashboards') {
    const id = parts[2];
    if (!id && method === 'GET') return json(res, 200, store.listDashboards());
    if (!id && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const newId = safeId(body.id) || crypto.randomBytes(5).toString('hex');
      if (store.getDashboard(newId)) return json(res, 409, { error: 'exists' });
      return json(res, 201, store.saveDashboard(newId, { name: body.name || 'New dashboard', widgets: [], ...body, id: newId }));
    }
    if (id && method === 'GET') { const d = store.getDashboard(id); return d ? json(res, 200, d) : json(res, 404, { error: 'not found' }); }
    if (id && method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      return json(res, 200, store.saveDashboard(id, body));
    }
    if (id && method === 'DELETE') return json(res, store.deleteDashboard(id) ? 200 : 404, {});
  }
  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p.startsWith('/d/')) p = '/index.html';
  if (p === '/explorer') p = '/explorer.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (!checkBasicAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MQTT Dash"' });
    return res.end('Authentication required');
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== config.mqtt.wsPath) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const remote = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || socket.remoteAddress;
  const ws = acceptUpgrade(req, socket, head);
  if (ws) broker.attach(ws, 'ws', remote);
});

server.listen(config.http.port, config.http.host, () => {
  console.log(`MQTT Dash UI       http://${config.http.host === '0.0.0.0' ? 'localhost' : config.http.host}:${config.http.port}/`);
  console.log(`MQTT over WS       ws://<host>:${config.http.port}${config.mqtt.wsPath}`);
});

// ---------- MQTT over TCP ----------
let tcp;
if (config.mqtt.enabled) {
  tcp = net.createServer((sock) => {
    sock.setNoDelay(true);
    broker.attach(sock, 'tcp', `${sock.remoteAddress}:${sock.remotePort}`);
  });
  tcp.listen(config.mqtt.port, config.mqtt.host, () => console.log(`MQTT broker (TCP)  mqtt://<host>:${config.mqtt.port}`));
}
console.log(`Data directory     ${dataDir}`);
console.log(`MQTT auth          ${config.auth.enabled ? 'enabled' : 'disabled (anonymous)'}`);

function saveState() {
  try { store.saveRetained(broker.retained); store.dirty = true; store.flushHistory(); } catch (e) { console.error(e); }
}
function shutdown() {
  console.log('shutting down…');
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
