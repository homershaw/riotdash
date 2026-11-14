#!/usr/bin/env node
'use strict';
// One-command Cloudflare Tunnel setup for riotdash.
//   ./deploy/cloudflare/setup.sh --hostname dash.example.com     (browser login, no API token)
//   ./deploy/cloudflare/setup.sh --token                         (use a Cloudflare API token instead)
//
// It will: make sure a login exists for internet access, create (or reuse) a Cloudflare Tunnel,
// point https://<hostname> at this machine, create the DNS record, install cloudflared and
// start it as a service, then check the site answers.
// The API token is only kept in memory; it is never written to disk or printed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const users = require('../server/users');

const API = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const step = (s) => console.log('\n' + c.b('▸ ' + s));
const ok = (s) => console.log('  ' + c.g('✓') + ' ' + s);
const warn = (s) => console.log('  ' + c.y('!') + ' ' + s);
function die(s) { console.error('\n' + c.r('✗ ' + s)); process.exit(1); }

// ---------- prompts ----------
function ask(q, def) {
  if (flag('yes') && def !== undefined) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(`  ${q}${def ? c.d(` [${def}]`) : ''}: `, (a) => { rl.close(); res(a.trim() || def || ''); }));
}
function askHidden(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else if (s === '\r\n' || s === '\n') rl.output.write(s); else rl.output.write('•'); };
    rl.question(`  ${q}: `, (a) => { rl.close(); process.stdout.write('\n'); res(a.trim()); });
  });
}
async function confirm(q) { if (flag('yes')) return true; return /^y/i.test(await ask(q + ' (y/n)', 'n')); }

// ---------- Cloudflare API ----------
let TOKEN = '';
const HINTS = {
  zones: 'Zone → Zone → Read and Zone → DNS → Edit',
  cfd_tunnel: 'Account → Cloudflare One Connector: cloudflared → Edit (called "Cloudflare Tunnel" on older accounts)',
  dns_records: 'Zone → DNS → Edit',
};
async function cf(method, p, body) {
  let r;
  try {
    r = await fetch(API + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  } catch (e) { die(`Couldn't reach Cloudflare (${e.message}). Is this machine online?`); }
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const msg = (j.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${r.status}`;
    const hint = Object.entries(HINTS).find(([k]) => p.includes(k));
    const perm = r.status === 403 || /auth|permission/i.test(msg);
    throw new Error(`${method} ${p.split('?')[0]} failed — ${msg}${perm && hint ? `\n  The API token needs: ${hint[1]}` : ''}`);
  }
  return j.result;
}

// ---------- local config ----------
function findConfig() {
  if (opt('config')) return path.resolve(opt('config'));
  if (process.env.MQTTDASH_CONFIG) return process.env.MQTTDASH_CONFIG;
  if (ROOT === '/opt/mqtt-dash' && fs.existsSync('/etc/mqtt-dash/config.json')) return '/etc/mqtt-dash/config.json';
  const local = path.join(ROOT, 'config.json');
  if (!fs.existsSync(local) && fs.existsSync(path.join(ROOT, 'config.example.json'))) fs.copyFileSync(path.join(ROOT, 'config.example.json'), local);
  return local;
}

function which(cmd) { return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim(); }
function run(cmd, a, quiet) {
  const r = spawnSync(cmd, a, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// Install cloudflared. Prefers Cloudflare's apt/yum package repository (stays updated with the system);
// falls back to downloading the binary with curl/wget, then Node.
async function installCloudflared() {
  const sh = (cmd) => spawnSync('sh', ['-c', cmd], { stdio: 'inherit' }).status === 0;
  if (which('apt-get')) {
    console.log(c.d("  using Cloudflare's apt repository…"));
    const ok1 = sh('mkdir -p --mode=0755 /usr/share/keyrings && ' + fetchCmd('https://pkg.cloudflare.com/cloudflare-main.gpg', '/usr/share/keyrings/cloudflare-main.gpg'))
      && sh('echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list')
      && sh('apt-get update -qq && apt-get install -y cloudflared');
    if (ok1 && which('cloudflared')) return;
    warn('apt install did not work, trying a direct download…');
  } else if (which('dnf') || which('yum')) {
    const pm = which('dnf') ? 'dnf' : 'yum';
    const ok1 = sh(fetchCmd('https://pkg.cloudflare.com/cloudflared.repo', '/etc/yum.repos.d/cloudflared.repo')) && sh(`${pm} install -y cloudflared`);
    if (ok1 && which('cloudflared')) return;
    warn(`${pm} install did not work, trying a direct download…`);
  }
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[os.arch()];
  if (!arch) throw new Error(`no cloudflared build for ${os.arch()}`);
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  const dest = '/usr/local/bin/cloudflared';
  if (which('curl') || which('wget')) {
    if (!sh(fetchCmd(url, dest))) throw new Error(`could not download ${url}`);
  } else {
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(180000) }); } catch (e) { throw new Error(`${e.message}${e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''} while downloading ${url}`); }
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  fs.chmodSync(dest, 0o755);
}
function fetchCmd(url, dest) {
  return which('curl') ? `curl -fsSL --retry 3 -o '${dest}' '${url}'` : `wget -q -O '${dest}' '${url}'`;
}

async function setupWithToken(port, skipInstall) {
  // token mode
  step('Cloudflare API token');
  TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!TOKEN) {
    console.log(c.d('  Create one at https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token, with:'));
    console.log(c.d('    Account → Cloudflare One Connector: cloudflared → Edit   (older accounts: Cloudflare Tunnel → Edit)'));
    console.log(c.d('    Zone → DNS → Edit      and    Zone → Zone → Read   (Zone resources: your domain)'));
    TOKEN = await askHidden('Paste the token (hidden)');
  }
  if (!TOKEN) die('No token given.');

  // 4. zone + hostname
  let zones;
  try { zones = await cf('GET', '/zones?per_page=50&status=active'); } catch (e) { die(e.message); }
  if (!zones.length) die('That token can\'t see any active domains. Give it Zone → Zone → Read for your domain.');
  ok(`domains: ${zones.map((z) => z.name).join(', ')}`);
  const defHost = opt('hostname') || `dash.${zones[0].name}`;
  const hostname = (opt('hostname') || await ask('Public address for riotdash', defHost)).toLowerCase();
  const zone = zones.filter((z) => hostname === z.name || hostname.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) die(`${hostname} isn't under any domain this token can manage (${zones.map((z) => z.name).join(', ')}).`);
  const accountId = zone.account.id;

  // 5. tunnel
  step('Tunnel');
  const tunnelName = opt('name', 'riotdash');
  let tunnel;
  try {
    const existing = await cf('GET', `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
    tunnel = existing[0];
    if (tunnel) ok(`reusing tunnel "${tunnelName}" (${tunnel.id})`);
    else { tunnel = await cf('POST', `/accounts/${accountId}/cfd_tunnel`, { name: tunnelName, config_src: 'cloudflare' }); ok(`created tunnel "${tunnelName}" (${tunnel.id})`); }
    await cf('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
      config: { ingress: [{ hostname, service: `http://localhost:${port}`, originRequest: {} }, { service: 'http_status:404' }] },
    });
    ok(`https://${hostname} → http://localhost:${port}`);
  } catch (e) { die(e.message); }

  // 6. DNS
  step('DNS');
  const target = `${tunnel.id}.cfargotunnel.com`;
  try {
    const recs = await cf('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
    const cname = recs.find((r) => r.type === 'CNAME');
    const other = recs.filter((r) => r.type !== 'CNAME');
    if (other.length) {
      if (!await confirm(`${hostname} already has ${other.map((r) => r.type).join('/')} record(s). Replace them?`)) die('Stopped — pick a different hostname with --hostname.');
      for (const r of other) await cf('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
    }
    if (cname && cname.content === target) ok(`${hostname} already points at the tunnel`);
    else if (cname) {
      if (!cname.content.endsWith('.cfargotunnel.com') && !await confirm(`${hostname} currently points at ${cname.content}. Point it at riotdash instead?`)) die('Stopped — pick a different hostname with --hostname.');
      await cf('PATCH', `/zones/${zone.id}/dns_records/${cname.id}`, { content: target, proxied: true });
      ok(`updated ${hostname} → tunnel`);
    } else {
      await cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: hostname, content: target, proxied: true, comment: 'riotdash tunnel' });
      ok(`created ${hostname} → tunnel`);
    }
  } catch (e) { die(e.message); }

  // 7. connector
  step('cloudflared on this machine');
  let tunnelToken;
  try { tunnelToken = await cf('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`); } catch (e) { die(e.message); }
  if (skipInstall) {
    warn('--skip-install: not touching cloudflared. To run the tunnel yourself:');
    console.log(c.d('    sudo cloudflared service install <tunnel token from the Cloudflare dashboard>'));
  } else {
    if (!which('cloudflared')) {
      console.log(c.d('  installing cloudflared…'));
      try { await installCloudflared(); } catch (e) { die('Could not install cloudflared: ' + e.message); }
    }
    ok('cloudflared ' + (run('cloudflared', ['--version'], true) || '').split('\n')[0].replace(/^cloudflared version /, ''));
    const active = run('systemctl', ['is-active', 'cloudflared'], true) === 'active';
    if (fs.existsSync('/etc/systemd/system/cloudflared.service') || active) {
      console.log(c.d('  replacing the existing cloudflared service…'));
      run('cloudflared', ['service', 'uninstall'], true);
    }
    if (run('cloudflared', ['service', 'install', tunnelToken], true) === null) die('`cloudflared service install` failed. Check: sudo journalctl -u cloudflared');
    ok('cloudflared service installed and started');
  }

  return hostname;
}

// ---------- browser-login mode (no API token) ----------
// Uses `cloudflared tunnel login`: you open a link, pick your domain, done.
function cfd(argsList, opts = {}) {
  const r = spawnSync('cloudflared', argsList, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function setupWithLogin(port) {
  step('cloudflared');
  if (!which('cloudflared')) {
    console.log(c.d('  installing cloudflared…'));
    try { await installCloudflared(); } catch (e) { die('Could not install cloudflared: ' + e.message); }
  }
  ok('cloudflared ' + (cfd(['--version']).out.split('\n')[0] || '').replace(/^cloudflared version /, ''));

  step('Log in to Cloudflare');
  const home = os.homedir();
  const cert = path.join(home, '.cloudflared', 'cert.pem');
  if (fs.existsSync(cert)) ok('already logged in (' + cert + ')');
  else {
    console.log('  A link will appear below. Open it on any computer or phone, sign in to Cloudflare,');
    console.log('  click ' + c.b('your domain') + ' (e.g. anyesp.com), then ' + c.b('Authorize') + '. This window continues by itself.\n');
    const r = cfd(['tunnel', 'login'], { inherit: true });
    if (!r.ok || !fs.existsSync(cert)) die('Cloudflare login did not finish. Run the setup again to retry.');
    ok('logged in');
  }

  const hostname = (opt('hostname') || await ask('Public address for riotdash (e.g. dash.anyesp.com)')).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) die(`"${hostname}" doesn't look like an address. Use something like dash.anyesp.com`);

  step('Tunnel');
  const name = opt('name', 'riotdash');
  const listTunnels = () => { const r = cfd(['tunnel', 'list', '--output', 'json']); try { return JSON.parse(r.out || '[]') || []; } catch { return []; } };
  let t = listTunnels().find((x) => x.name === name && !x.deleted_at);
  if (t) ok(`reusing tunnel "${name}" (${t.id})`);
  else {
    const r = cfd(['tunnel', 'create', name]);
    if (!r.ok) die('Creating the tunnel failed:\n' + (r.err || r.out));
    t = listTunnels().find((x) => x.name === name);
    if (!t) { const m = (r.out + r.err).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); if (m) t = { id: m[0] }; }
    if (!t) die('Tunnel was created but its ID could not be read. Run the setup again.');
    ok(`created tunnel "${name}" (${t.id})`);
  }

  step('DNS');
  let r = cfd(['tunnel', 'route', 'dns', name, hostname]);
  if (!r.ok && /already exists|exist/i.test(r.err + r.out)) {
    if (!await confirm(`${hostname} already has a DNS record. Point it at riotdash instead?`)) die('Stopped — pick a different address with --hostname.');
    r = cfd(['tunnel', 'route', 'dns', '--overwrite-dns', name, hostname]);
  }
  if (!r.ok) die('Creating the DNS record failed:\n' + (r.err || r.out) + '\n(The address must be under the domain you picked when logging in.)');
  ok(`${hostname} → tunnel`);

  step('Running the tunnel as a service');
  const etc = '/etc/cloudflared';
  fs.mkdirSync(etc, { recursive: true });
  const credSrc = path.join(home, '.cloudflared', `${t.id}.json`);
  const credDst = path.join(etc, `${t.id}.json`);
  if (fs.existsSync(credSrc)) fs.copyFileSync(credSrc, credDst);
  if (!fs.existsSync(credDst)) die(`Tunnel credentials not found (${credSrc}). If the tunnel was created on another machine, delete it in the Cloudflare dashboard or use --name newname.`);
  fs.chmodSync(credDst, 0o600);
  const yml = `# Written by riotdash tools/cloudflare-setup.js\ntunnel: ${t.id}\ncredentials-file: ${credDst}\n\ningress:\n  - hostname: ${hostname}\n    service: http://localhost:${port}\n  - service: http_status:404\n`;
  fs.writeFileSync(path.join(etc, 'config.yml'), yml);
  ok(`${etc}/config.yml: https://${hostname} → http://localhost:${port}`);
  const hasService = fs.existsSync('/etc/systemd/system/cloudflared.service') || run('systemctl', ['is-enabled', 'cloudflared'], true) !== null;
  if (hasService) {
    if (run('systemctl', ['restart', 'cloudflared'], true) === null) die('Restarting cloudflared failed. Check: sudo journalctl -u cloudflared');
    ok('cloudflared service restarted with the new settings');
  } else {
    const s2 = cfd(['service', 'install']);
    if (!s2.ok) die('`cloudflared service install` failed:\n' + (s2.err || s2.out));
    ok('cloudflared service installed and started');
  }
  return hostname;
}

// ---------- main ----------
(async () => {
  console.log(c.b('\nriotdash · Cloudflare setup\n') + c.d('Publishes this dashboard and broker at https://<your hostname> through a Cloudflare Tunnel.'));
  const skipInstall = flag('skip-install');
  if (!skipInstall && process.getuid && process.getuid() !== 0) die('Run this with sudo so it can install cloudflared as a service:\n  ./deploy/cloudflare/setup.sh');

  // 1. local settings
  step('Checking this riotdash install');
  const cfgPath = findConfig();
  const cfg = users.readConfig(cfgPath);
  const port = Number(process.env.HTTP_PORT || cfg.http?.port || 8080);
  ok(`config: ${cfgPath}`);
  ok(`dashboard port: ${port}`);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) ok('riotdash is running'); else warn(`riotdash answered ${r.status} on port ${port}`);
  } catch { warn(`riotdash isn't answering on port ${port} right now — that's fine, but start it before testing the site.`); }

  // 2. a login for internet access
  step('Login for access from the internet');
  console.log(c.d('  Anything that comes in through Cloudflare must log in. Devices on your home network keep working as before.'));
  let list = users.listUsers(cfgPath);
  if (list.length) {
    ok(`existing logins: ${list.map((u) => u.username).join(', ')}`);
  } else {
    const name = await ask('Choose a username', 'admin');
    let pw = '', pw2 = ' ';
    while (pw !== pw2) {
      pw = await askHidden('Choose a password (8+ characters)');
      if (pw.length < 8) { warn('Too short.'); pw2 = ' '; continue; }
      pw2 = await askHidden('Repeat the password');
      if (pw !== pw2) warn("Those didn't match, try again.");
    }
    users.addUser(cfgPath, name, pw);
    ok(`login "${name}" saved (riotdash picks it up within a few seconds — no restart needed)`);
  }
  if (cfg.remote && cfg.remote.requireLogin === false) warn('remote.requireLogin is false in config.json — internet visitors would NOT need to log in. Set it to true.');

  // 3. connect to Cloudflare: browser login (default) or API token
  const useToken = !!process.env.CLOUDFLARE_API_TOKEN || flag('token');
  const hostname = useToken ? await setupWithToken(port, skipInstall) : await setupWithLogin(port);

  // 8. check
  step('Checking https://' + hostname);
  let up = false;
  for (let i = 0; i < (flag('no-check') ? 0 : 30) && !up; i++) {
    try { const r = await fetch(`https://${hostname}/healthz`, { signal: AbortSignal.timeout(5000) }); up = r.ok; } catch { /* DNS or tunnel still starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 3000));
  }
  if (up) ok('the site answers');
  else warn("It isn't answering yet. New DNS names can take a few minutes. Check again shortly, and that riotdash is running.");

  console.log(`
${c.b('Done.')}
  Dashboard      ${c.b(`https://${hostname}`)}      (log in with the username/password above)
  Explorer       https://${hostname}/explorer
  MQTT devices   ${c.b(`wss://${hostname}/mqtt`)}  port 443, same username/password
  On your network nothing changes: http://<this machine>:${port} and mqtt://<this machine>:1883

  Add more logins any time:   node server/index.js add-user <name> <password>
`);
})().catch((e) => die(e.stack || e.message));
