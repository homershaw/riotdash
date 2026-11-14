#!/usr/bin/env node
'use strict';
// MQTT Dash: MQTT broker (TCP + WebSocket) + drag-and-drop dashboard server. No dependencies.

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Broker, hashPassword, verifyPassword } = require('./broker');
const users = require('./users');
const { Riots } = require('./riot');
const { acceptUpgrade } = require('./websocket');
const { Store, safeId } = require('./store');
const updater = require('./updater');

const ROOT = path.resolve(__dirname, '..');

// Prefer IPv4 for outgoing connections (GitHub updates, Cloudflare). On networks where DNS returns
// IPv6 addresses but there's no working IPv6 route, Node otherwise stalls until it times out.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch { /* old Node */ }
try { require('net').setDefaultAutoSelectFamily?.(true); } catch { /* old Node */ }


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
const CLI = ['set-admin-password', 'update', 'add-user', 'remove-user', 'list-users'].includes(process.argv[2]);
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
  updates: { github: 'homershaw/riotdash', channel: 'main' },
  remote: { requireLogin: true },
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
  remote: { ...DEFAULTS.remote, ...(fileCfg.remote || {}) },
};
if (process.env.HTTP_PORT) config.http.port = Number(process.env.HTTP_PORT);
if (process.env.MQTT_PORT) config.mqtt.port = Number(process.env.MQTT_PORT);
const dataDir = path.resolve(path.dirname(configPath), process.env.MQTTDASH_DATA || config.dataDir);

// ---------- CLI: users ----------
if (process.argv[2] === 'add-user') {
  const [, , , name, pw, ...publish] = process.argv;
  if (!name || !pw) { console.error('usage: node server/index.js add-user <username> <password> [allowed-publish-topic ...]'); process.exit(1); }
  try { console.log(`User "${name}" ${users.addUser(configPath, name, pw, publish)} in ${configPath}.`); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); }
}
if (process.argv[2] === 'remove-user') {
  const name = process.argv[3];
  if (!name) { console.error('usage: node server/index.js remove-user <username>'); process.exit(1); }
  console.log(users.removeUser(configPath, name) ? `Removed "${name}".` : `No user "${name}".`); process.exit(0);
}
if (process.argv[2] === 'list-users') {
  const list = users.listUsers(configPath);
  if (!list.length) console.log('No users yet. Add one with: node server/index.js add-user <username> <password>');
  for (const u of list) console.log(`${u.username}${u.publish ? '   (may publish to: ' + u.publish.join(', ') + ')' : ''}`);
  process.exit(0);
}

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

updater.fixScriptModes(ROOT);

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

// RIOT controllers: discovery, approval and decoding (server/riot.js)
const riots = new Riots({ broker, store, config, log: (...a) => broker.log(...a) });
for (const [topic, m] of broker.retained) { try { riots.onMessage({ topic, payload: m.payload, retain: true }); } catch { /* ignore */ } }

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

// Requests that come through Cloudflare carry these headers; nothing else can reach us from the internet
// (no open ports), so they're a reliable "this is from the internet" signal.
const viaInternet = (req) => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

function basicCreds(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const s = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = s.indexOf(':');
  return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
}

const loginCache = new Map(); // sha256(user:pass) -> expiry (scrypt is slow; don't run it for every file)
function userLogin(creds) {
  if (!creds) return null;
  const key = crypto.createHash('sha256').update(creds.user + '\0' + creds.pass).digest('hex');
  const hit = loginCache.get(key);
  if (hit && hit.exp > Date.now() && (config.auth.users || []).some((u) => u.username === hit.user)) return hit.user;
  const u = (config.auth.users || []).find((x) => x.username === creds.user);
  if (!u || !verifyPassword(u, creds.pass)) return null;
  loginCache.set(key, { user: u.username, exp: Date.now() + 10 * 60e3 });
  return u.username;
}

// Returns { ok, user, reason }
function httpAuth(req) {
  const creds = basicCreds(req);
  const ba = config.http.basicAuth;
  if (ba && ba.username) { // legacy: one fixed login for everyone
    const a = crypto.createHash('sha256').update(`${creds?.user}:${creds?.pass}`).digest();
    const b = crypto.createHash('sha256').update(`${ba.username}:${ba.password}`).digest();
    if (!creds || !crypto.timingSafeEqual(a, b)) return { ok: false };
  }
  if (viaInternet(req) && config.remote.requireLogin) {
    const real = (config.auth.users || []).filter((u) => !(u.passwordHash || '').includes('REPLACE_ME'));
    if (!real.length) return { ok: false, reason: 'no-users' };
    const user = userLogin(creds);
    return user ? { ok: true, user } : { ok: false };
  }
  return { ok: true, user: null };
}

async function handleRiotApi(req, res, parts) {
  const m = req.method;
  const body = async () => JSON.parse((await readBody(req)) || '{}');
  try {
    if (parts[1] === 'riot-profiles') {
      const model = decodeURIComponent(parts[2] || '');
      if (!model) return json(res, 200, riots.profiles);
      if (m === 'GET') return json(res, 200, riots.profile(model));
      if (m === 'PUT') {
        const b = await body();
        const p = riots.setProfile(model, b);
        const rebuilt = b.rebuild ? riots.rebuildModel(model) : 0;
        return json(res, 200, { ok: true, profile: p, rebuilt });
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    const id = parts[2] ? decodeURIComponent(parts[2]) : null;
    if (!id && m === 'GET') return json(res, 200, { prefix: riots.prefix, devices: riots.list(), profiles: riots.profiles });
    if (!id) return json(res, 405, { error: 'method not allowed' });
    const action = parts[3];
    if (m === 'POST' && action === 'approve') { const b = await body(); riots.approve(id, b.name); return json(res, 200, { ok: true, dashboard: require('./riot-pages').pageId(id) }); }
    if (m === 'POST' && action === 'reject') { riots.reject(id); return json(res, 200, { ok: true }); }
    if (m === 'POST' && action === 'rebuild') { riots.buildPage(id); riots.buildOverview(); return json(res, 200, { ok: true }); }
    if (m === 'PUT' && !action) { const b = await body(); riots.update(id, b); if (b.rebuild) { riots.buildPage(id); riots.buildOverview(); } return json(res, 200, { ok: true }); }
    if (m === 'DELETE' && !action) { riots.forget(id); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'not found' });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'update') return handleUpdateApi(req, res, parts, url);
  // MQTT credentials for a browser that logged in over the internet
  if (parts[1] === 'session' && method === 'GET') {
    if (!req.authUser) return json(res, 200, { username: null, internet: viaInternet(req) });
    return json(res, 200, { username: req.authUser, password: 'session:' + broker.issueToken(req.authUser), internet: true });
  }
  if (parts[1] === 'info' && method === 'GET') {
    return json(res, 200, {
      name: 'MQTT Dash', version: updater.appVersion(ROOT),
      clients: broker.sessions.size, retained: broker.retained.size, messagesIn: broker.stats.messagesIn,
      uptime: Math.round((Date.now() - broker.stats.started) / 1000),
      mqttPort: config.mqtt.port, wsPath: config.mqtt.wsPath, authEnabled: !!config.auth.enabled, riotsPending: riots.pendingCount(),
    });
  }
  if (parts[1] === 'riots' || parts[1] === 'riot-profiles') return handleRiotApi(req, res, parts);
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
  if (p === '/riots') p = '/riots.html';
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
  const auth = httpAuth(req);
  if (!auth.ok) {
    if (auth.reason === 'no-users') {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Remote access is not set up yet: add a login on the server with\n\n  node server/index.js add-user <username> <password>\n');
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="riotdash", charset="UTF-8"', 'Content-Type': 'text/plain' });
    return res.end('Login required');
  }
  req.authUser = auth.user;
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
  if (ws) broker.attach(ws, 'ws', remote, { viaInternet: viaInternet(req) });
});

// Friendly message instead of a stack trace when a port is taken.
function portError(what, port, envVar) {
  return (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n✗ Port ${port} (${what}) is already in use — riotdash may already be running.`);
      console.error('  Check:   pgrep -af "server/index.js"      or   systemctl status riotdash');
      console.error(`  Or use another port: ${envVar}=<port> node server/index.js   (or change it in config.json)\n`);
    } else if (e.code === 'EACCES') {
      console.error(`\n✗ Not allowed to use port ${port} (${what}). Ports below 1024 need root — pick a higher one in config.json.\n`);
    } else console.error(`\n✗ ${what} port ${port}: ${e.message}\n`);
    process.exit(2);
  };
}
server.on('error', portError('web / MQTT over WebSockets', config.http.port, 'HTTP_PORT'));

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
  tcp.on('error', portError('MQTT', config.mqtt.port, 'MQTT_PORT'));
  tcp.listen(config.mqtt.port, config.mqtt.host, () => console.log(`MQTT broker (TCP)  mqtt://<host>:${config.mqtt.port}`));
}
console.log(`Data directory     ${dataDir}`);
console.log(`MQTT auth          ${config.auth.enabled ? 'enabled' : 'off on your network'}${config.remote.requireLogin ? ' · login required from the internet' : ''}`);

// Pick up user/remote-login changes in config.json without a restart (e.g. after add-user).
fs.watchFile(configPath, { interval: 2000 }, () => {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.auth = { ...DEFAULTS.auth, ...(c.auth || {}) };
    config.remote = { ...DEFAULTS.remote, ...(c.remote || {}) };
    config.http.basicAuth = (c.http || {}).basicAuth || null;
    config.updates = { ...DEFAULTS.updates, ...(c.updates || {}) };
    loginCache.clear();
    console.log(`config.json reloaded (${(config.auth.users || []).length} user(s)). Port changes need a restart.`);
  } catch (e) { console.error('config.json has an error, keeping the previous settings:', e.message); }
}).unref?.();

function saveState() {
  try { riots.flush(); } catch { /* ignore */ }
  try { store.saveRetained(broker.retained); store.dirty = true; store.flushHistory(); } catch (e) { console.error(e); }
}
function shutdown() {
  console.log('shutting down…');
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
