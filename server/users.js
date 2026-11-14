'use strict';
// Manage login users in config.json (auth.users). Used by the CLI and the Cloudflare setup script.
// The same users log in to the dashboard over the internet and to the broker (MQTT).

const fs = require('fs');
const { hashPassword } = require('./broker');

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Write config.json without changing who owns it (matters when run with sudo).
function writeConfig(file, cfg) {
  let st = null;
  try { st = fs.statSync(file); } catch { /* new file */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: st ? st.mode & 0o777 : 0o640 });
  if (st) { try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* not root */ } }
  fs.renameSync(tmp, file);
}

function validName(u) { return /^[A-Za-z0-9._@-]{1,64}$/.test(u || ''); }

function addUser(file, username, password, publish) {
  if (!validName(username)) throw new Error('Username may only contain letters, numbers and . _ @ -');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  const cfg = readConfig(file);
  cfg.auth = cfg.auth || { enabled: false, users: [] };
  // drop the placeholder user shipped in config.example.json
  cfg.auth.users = (cfg.auth.users || []).filter((u) => !(u.passwordHash || '').includes('REPLACE_ME'));
  const entry = { username, passwordHash: hashPassword(password) };
  if (publish && publish.length) entry.publish = publish;
  const i = cfg.auth.users.findIndex((u) => u.username === username);
  if (i >= 0) cfg.auth.users[i] = { ...cfg.auth.users[i], ...entry };
  else cfg.auth.users.push(entry);
  writeConfig(file, cfg);
  return i >= 0 ? 'updated' : 'added';
}

function removeUser(file, username) {
  const cfg = readConfig(file);
  const before = (cfg.auth?.users || []).length;
  if (!cfg.auth) return false;
  cfg.auth.users = (cfg.auth.users || []).filter((u) => u.username !== username);
  writeConfig(file, cfg);
  return cfg.auth.users.length < before;
}

function listUsers(file) {
  return (readConfig(file).auth?.users || []).filter((u) => !(u.passwordHash || '').includes('REPLACE_ME')).map((u) => ({ username: u.username, publish: u.publish || null }));
}

module.exports = { readConfig, writeConfig, addUser, removeUser, listUsers, validName };
