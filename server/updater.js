'use strict';
// In-app updates: validates an uploaded mqtt-dash .tar.gz, backs up the current app files,
// swaps in the new ones and lets the supervisor restart the worker. Config and data are never touched.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Only these top-level entries are replaced by an update. config.json and data/ are never in this list.
const MANAGED = ['server', 'public', 'tools', 'deploy', 'package.json', 'README.md', 'CHANGELOG.md', 'config.example.json'];
const KEEP_BACKUPS = 3;

// ---------- tar reader (ustar + GNU long names + pax path) ----------
function readTar(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const out = [];
  let off = 0, longName = null, paxPath = null;
  const str = (o, n) => { const s = buf.subarray(o, o + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('utf8'); };
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    let name = str(off, 100);
    const prefix = str(off + 345, 155);
    if (prefix && buf.subarray(off + 257, off + 262).toString() === 'ustar') name = prefix + '/' + name;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') { const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '\0' || type === '7') out.push({ name, data: Buffer.from(data) });
  }
  return out;
}

// Strip the leading "mqtt-dash/" folder and refuse anything that escapes or isn't a managed path.
function normaliseEntries(entries) {
  const files = [];
  for (const e of entries) {
    let parts = e.name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
    if (parts.length > 1 && !MANAGED.includes(parts[0])) parts = parts.slice(1); // top-level folder
    if (!parts.length || parts.includes('..')) continue;
    if (!MANAGED.includes(parts[0])) continue;
    files.push({ rel: parts.join('/'), data: e.data });
  }
  return files;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const appVersion = (root) => readJson(path.join(root, 'package.json'))?.version || '0.0.0';

function firstChangelogSection(md) {
  if (!md) return '';
  const sections = md.split(/^(?=## )/m).filter((x) => x.startsWith('## '));
  return sections.length ? sections[0].trim() : '';
}

function stageUpdate(root, buf) {
  let entries;
  try { entries = readTar(buf); } catch (e) { throw new Error('Not a valid .tar.gz package (' + e.message + ')'); }
  const files = normaliseEntries(entries);
  const pkgFile = files.find((f) => f.rel === 'package.json');
  if (!pkgFile) throw new Error('Package has no package.json — is this an MQTT Dash release?');
  let pkg;
  try { pkg = JSON.parse(pkgFile.data.toString('utf8')); } catch { throw new Error('package.json in the upload is not valid JSON'); }
  if (pkg.name !== 'mqtt-dash') throw new Error(`This package is "${pkg.name}", not mqtt-dash`);
  if (!files.some((f) => f.rel === 'server/index.js')) throw new Error('Package is missing server/index.js');

  const staging = path.join(root, '.update-staging');
  rmrf(staging);
  for (const f of files) {
    const dest = path.join(staging, f.rel);
    if (!dest.startsWith(staging + path.sep)) throw new Error('Unsafe path in package: ' + f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
  // Syntax-check every server/tools file with the running Node before touching anything.
  for (const dir of ['server', 'tools']) {
    const d = path.join(staging, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', path.join(d, f)], { encoding: 'utf8' });
      if (r.status !== 0) { rmrf(staging); throw new Error(`New version failed a syntax check in ${dir}/${f}: ${(r.stderr || '').split('\n').slice(0, 3).join(' ')}`); }
    }
  }
  const changelog = files.find((f) => f.rel === 'CHANGELOG.md');
  return { staging, version: pkg.version || '0.0.0', notes: firstChangelogSection(changelog?.data.toString('utf8')), count: files.length };
}

function swapIn(root, srcDir, label) {
  const backups = path.join(root, '.backups');
  fs.mkdirSync(backups, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_v${appVersion(root)}${label ? '_' + label : ''}`;
  const bdir = path.join(backups, id);
  fs.mkdirSync(bdir);
  const moved = [];
  try {
    for (const name of MANAGED) {
      const cur = path.join(root, name);
      if (fs.existsSync(path.join(srcDir, name)) && fs.existsSync(cur)) { fs.renameSync(cur, path.join(bdir, name)); moved.push(name); }
    }
    for (const name of MANAGED) {
      const src = path.join(srcDir, name);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(root, name));
    }
  } catch (e) {
    // put things back the way they were
    for (const name of moved) { try { rmrf(path.join(root, name)); fs.renameSync(path.join(bdir, name), path.join(root, name)); } catch { /* best effort */ } }
    throw e;
  }
  pruneBackups(root);
  return id;
}

function applyUpdate(root, buf) {
  const from = appVersion(root);
  const st = stageUpdate(root, buf);
  const backupId = swapIn(root, st.staging, '');
  rmrf(st.staging);
  return { from, to: st.version, notes: st.notes, backupId, files: st.count };
}

function listBackups(root) {
  const dir = path.join(root, '.backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'package.json'))).sort().reverse().map((id) => ({
    id, version: readJson(path.join(dir, id, 'package.json'))?.version || '?', date: fs.statSync(path.join(dir, id)).mtimeMs,
  }));
}

function pruneBackups(root) {
  const all = listBackups(root);
  for (const b of all.slice(KEEP_BACKUPS)) rmrf(path.join(root, '.backups', b.id));
}

function rollback(root, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('bad backup id');
  const src = path.join(root, '.backups', id);
  if (!fs.existsSync(path.join(src, 'package.json'))) throw new Error('Backup not found');
  const from = appVersion(root);
  const to = readJson(path.join(src, 'package.json'))?.version;
  // move backup contents to a temp dir first so swapIn can make a backup of the current version
  const tmp = path.join(root, '.update-staging');
  rmrf(tmp);
  fs.renameSync(src, tmp);
  const backupId = swapIn(root, tmp, 'before-rollback');
  rmrf(tmp);
  return { from, to, backupId };
}

function isWritable(root) {
  try { fs.accessSync(root, fs.constants.W_OK); for (const m of ['server', 'public']) fs.accessSync(path.join(root, m), fs.constants.W_OK); return true; } catch { return false; }
}

// ---------- admin password (stored in the data dir, not the config) ----------
function adminFile(dataDir) { return path.join(dataDir, 'admin.json'); }
function adminIsSet(dataDir) { return !!readJson(adminFile(dataDir))?.hash; }
function setAdminPassword(dataDir, pw) {
  if (!pw || String(pw).length < 6) throw new Error('Password must be at least 6 characters');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  fs.writeFileSync(adminFile(dataDir), JSON.stringify({ hash: `scrypt$${salt.toString('hex')}$${hash.toString('hex')}` }), { mode: 0o600 });
}
function checkAdminPassword(dataDir, pw) {
  const rec = readJson(adminFile(dataDir));
  if (!rec?.hash || !pw) return false;
  const [, salt, hash] = rec.hash.split('$');
  const calc = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(hash, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

// A request counts as "local" if it comes from a private/loopback address and not through a proxy/tunnel.
function isLocalRequest(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray']) return false;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

// ---------- GitHub update source ----------
// Stable channel: highest vX.Y.Z tag in the repo. Main channel: whatever is on the main branch.
const ver = (v) => String(v || '0').replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
function cmpVer(a, b) { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }

// Endpoints can be overridden for testing.
const GH_API = process.env.RIOTDASH_GH_API || 'https://api.github.com';
const GH_RAW = process.env.RIOTDASH_GH_RAW || 'https://raw.githubusercontent.com';
const GH_CODELOAD = process.env.RIOTDASH_GH_CODELOAD || 'https://codeload.github.com';

async function gh(url, timeout = 15000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'riotdash-updater', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'GitHub rate limit reached — try again in a few minutes' : `GitHub returned ${r.status} for ${url}`);
  return r;
}

async function checkGithub(repo, channel, current) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('updates.github in config.json must look like owner/repo');
  let latest, refName, ref;
  if (channel === 'main') {
    let pkg;
    try { pkg = await (await gh(`${GH_RAW}/${repo}/main/package.json`)).json(); } catch (e) {
      if (/ 404 /.test(e.message)) return { current, latest: null, available: false, message: 'Nothing has been published to the main branch yet.' };
      throw e;
    }
    latest = pkg.version;
    refName = 'main'; ref = 'heads/main';
  } else {
    const tags = (await (await gh(`${GH_API}/repos/${repo}/tags?per_page=100`)).json()).map((t) => t.name).filter((n) => /^v?\d+\.\d+\.\d+$/.test(n));
    if (!tags.length) return { current, latest: null, available: false, message: 'No releases have been published yet.' };
    tags.sort((a, b) => cmpVer(b, a));
    refName = tags[0]; ref = 'tags/' + tags[0]; latest = tags[0].replace(/^v/, '');
  }
  let notes = '';
  try { notes = firstChangelogSection(await (await gh(`${GH_RAW}/${repo}/${refName}/CHANGELOG.md`)).text()); } catch { /* optional */ }
  return { current, latest, available: cmpVer(latest, current) > 0, refName, notes, url: `${GH_CODELOAD}/${repo}/tar.gz/refs/${ref}` };
}

async function downloadGithub(url) {
  const r = await gh(url, 180000);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 50 * 1024 * 1024) throw new Error('Download is unexpectedly large');
  return buf;
}

module.exports = { checkGithub, downloadGithub, cmpVer, applyUpdate, listBackups, rollback, isWritable, appVersion, adminIsSet, setAdminPassword, checkAdminPassword, isLocalRequest, readTar, MANAGED };
