// Updates dialog: admin password setup, upload & install, rollback, wait for restart.
import { h } from './widgets.js';

const $ = (s) => document.querySelector(s);
let file = null;
let status = null;

let gh = null;

async function checkGithub(force) {
  const box = $('#ghBox');
  $('#ghStatus').textContent = 'Checking GitHub for updates…';
  $('#ghGo').hidden = true; $('#ghNotes').hidden = true; box.classList.remove('available');
  try {
    gh = await (await fetch('/api/update/check' + (force ? '?force=1' : ''))).json();
  } catch { gh = { error: 'Could not reach the server' }; }
  showBadge(gh);
  if (gh.disabled) { $('#ghStatus').textContent = 'GitHub updates are turned off (updates.github is empty in config.json).'; return; }
  $('#ghSource').textContent = gh.repo ? `github.com/${gh.repo} · ${gh.channel === 'main' ? 'latest main branch' : 'stable releases'}` : '';
  if (gh.error) { $('#ghStatus').textContent = 'Couldn’t check for updates: ' + gh.error; return; }
  if (!gh.latest) { $('#ghStatus').textContent = gh.message || 'No releases found.'; return; }
  if (gh.available) {
    box.classList.add('available');
    $('#ghStatus').innerHTML = `<b>v${gh.latest}</b> is available — you have v${gh.current}.`;
    $('#ghGo').hidden = false; $('#ghGo').textContent = `Update to v${gh.latest}`;
    if (gh.notes) { $('#ghNotes').hidden = false; $('#ghNotes').textContent = gh.notes.replace(/^##\s*/, 'What’s new in '); }
  } else {
    $('#ghStatus').textContent = `You’re up to date (v${gh.current}).`;
  }
}

async function updateFromGithub() {
  const pw = $('#updPw').value;
  if (!pw) { setStatus('Enter the admin password.', 'err'); $('#updPw').focus(); return; }
  $('#ghGo').disabled = true;
  setStatus(`Downloading v${gh.latest} from GitHub and checking it…`);
  try {
    const r = await fetch('/api/update/github', { method: 'POST', headers: { 'X-Admin-Password': pw } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    await afterInstall(j);
  } catch (e) { setStatus('Update failed: ' + e.message + '\nNothing was changed.', 'err'); }
  $('#ghGo').disabled = false;
}

async function afterInstall(j) {
  setStatus(`Installed v${j.to} (was v${j.from}). Restarting…`, 'ok');
  const back = await waitForRestart(j.to);
  if (back) { setStatus(`Installed v${j.to}. Restarted — reloading the page…`, 'ok'); setTimeout(() => location.reload(), 1200); }
  else setStatus('The update was installed but the server hasn’t come back yet. Check the server log, or roll back from this dialog once it’s up.', 'err');
}

function showBadge(c) {
  const on = !!(c && c.available);
  const dot = document.querySelector('#settingsBtn .upd-dot');
  if (dot) dot.hidden = !on;
  $('#aboutUpd').textContent = on ? `· update available (v${c.latest})` : '';
}

export async function refreshVersion() {
  try { const i = await (await fetch('/api/info')).json(); $('#appVersion').textContent = 'v' + i.version; return i.version; } catch { return null; }
}

function setStatus(text, kind = '') {
  const el = $('#updStatus');
  el.hidden = !text; el.textContent = text || ''; el.className = 'upd-status ' + kind;
}

async function load() {
  status = await (await fetch('/api/update/status')).json();
  $('#updCurrent').textContent = 'v' + status.version;
  $('#updSetAdmin').hidden = status.adminSet || !status.canSetAdmin;
  $('#updNoAdmin').hidden = status.adminSet || status.canSetAdmin;
  $('#updInstall').hidden = !status.adminSet;
  const warn = !status.writable ? 'The server can’t write to its app folder, so it can’t update itself. If you installed it as a service, run deploy/install.sh once from this version to fix permissions.' : '';
  $('#updWarn').hidden = !warn; $('#updWarn').textContent = warn;
  if (status.adminSet) checkGithub(false);
  $('#updBackups').replaceChildren(...(status.backups.length ? status.backups.map((b) => h('div', { class: 'bk' },
    h('span', {}, h('b', {}, 'v' + b.version), ' ', h('small', {}, new Date(b.date).toLocaleString())),
    h('button', { class: 'btn', type: 'button', onclick: () => rollback(b) }, 'Roll back'))) : [h('small', { class: 'hint' }, 'None yet — a backup is kept automatically each time you update.')]));
}

function pickFile(f) {
  if (!f) return;
  if (!/\.(tar\.gz|tgz|tar|gz)$/i.test(f.name)) { setStatus('Choose the mqtt-dash .tar.gz file you downloaded.', 'err'); return; }
  file = f;
  $('#updDropText').innerHTML = `<b>${f.name.replace(/[<>&]/g, '')}</b> · ${(f.size / 1024).toFixed(0)} KB — click to change`;
  $('#updGo').disabled = false;
  setStatus('');
}

async function waitForRestart(expectVersion) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 1200));
  while (Date.now() - t0 < 45000) {
    try {
      const i = await (await fetch('/api/info', { cache: 'no-store' })).json();
      if (!expectVersion || i.version === expectVersion) return true;
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function install() {
  if (!file) return;
  const pw = $('#updPw').value;
  if (!pw) { setStatus('Enter the admin password.', 'err'); return; }
  $('#updGo').disabled = true;
  setStatus('Uploading and checking the package…');
  try {
    const r = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Admin-Password': pw }, body: await file.arrayBuffer() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    await afterInstall(j);
  } catch (e) {
    setStatus('Update failed: ' + e.message + '\nNothing was changed.', 'err');
    $('#updGo').disabled = false;
  }
}

async function rollback(b) {
  const pw = $('#updPw').value;
  if (!pw) { setStatus('Enter the admin password first, then click Roll back.', 'err'); $('#updPw').focus(); return; }
  if (!confirm(`Roll back to v${b.version}? The current version is kept as a backup.`)) return;
  setStatus(`Rolling back to v${b.version}…`);
  try {
    const r = await fetch('/api/update/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pw }, body: JSON.stringify({ id: b.id }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    setStatus(`Rolled back to v${j.to}. Restarting…`, 'ok');
    if (await waitForRestart(j.to)) setTimeout(() => location.reload(), 800);
  } catch (e) { setStatus('Rollback failed: ' + e.message, 'err'); }
}

async function saveAdmin() {
  const a = $('#admPw1').value, b = $('#admPw2').value;
  if (a.length < 6) { alert('Use at least 6 characters.'); return; }
  if (a !== b) { alert('The passwords don’t match.'); return; }
  const r = await fetch('/api/update/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: a }) });
  const j = await r.json();
  if (!r.ok) { alert(j.error || 'Could not save'); return; }
  $('#updPw').value = a;
  await load();
}

export function initUpdates() {
  refreshVersion();
  const dlg = $('#updateDlg');
  $('#openUpdates').addEventListener('click', async () => { $('#settingsDlg').close(); file = null; $('#updGo').disabled = true; $('#updDropText').innerHTML = '<b>Choose a riotdash .tar.gz</b> or drop it here'; setStatus(''); dlg.showModal(); await load(); });
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  $('#updFile').addEventListener('change', (e) => pickFile(e.target.files[0]));
  const drop = $('#updDrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pickFile(e.dataTransfer.files[0]); });
  $('#updGo').addEventListener('click', install);
  $('#ghGo').addEventListener('click', updateFromGithub);
  $('#ghCheck').addEventListener('click', () => checkGithub(true));
  // quiet background check so the ⚙ button can show a dot when an update exists
  setTimeout(() => fetch('/api/update/check').then((r) => r.json()).then(showBadge).catch(() => {}), 3000);
  $('#admSave').addEventListener('click', saveAdmin);
}
