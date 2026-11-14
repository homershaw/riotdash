// Riots page: approve new controllers, manage approved ones, edit model-profile and per-controller labels.
import { h } from './widgets.js';

const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const ago = (t) => { if (!t) return '—'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString(); };
function toast(msg, kind = '') { const t = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t); setTimeout(() => t.classList.add('out'), 2600); setTimeout(() => t.remove(), 3000); }
try { document.documentElement.dataset.theme = JSON.parse(localStorage.getItem('mqttdash.theme') || '"dark"'); } catch { /* default */ }

let data = { devices: [], profiles: {}, prefix: 'riot' }, values = new Map();
const dot = (online) => h('i', { class: 'dot ' + (online === true ? 'on' : online === false ? 'off' : ''), title: online === true ? 'online' : online === false ? 'offline' : 'unknown' });

async function load() {
  try {
    data = await api('/api/riots');
    const topics = await api('/api/topics');
    values = new Map(topics.filter((t) => t.topic.startsWith(data.prefix + '/')).map((t) => [t.topic, t.payload]));
  } catch (e) { toast('Could not load: ' + e.message, 'error'); return; }
  render();
}

function render() {
  $('#prefixHint').textContent = `${data.prefix}/<id>/info`;
  const pending = data.devices.filter((d) => d.state === 'pending'), approved = data.devices.filter((d) => d.state === 'approved'), rejected = data.devices.filter((d) => d.state === 'rejected');
  $('#pendingCount').textContent = pending.length || '';

  // Waiting for approval
  const keep = document.activeElement && document.activeElement.closest('.rcard') ? document.activeElement.closest('.rcard').dataset.id : null;
  if (!keep) $('#pending').replaceChildren(...(pending.length ? pending.map(pendingCard) : [h('div', { class: 'empty' }, 'Nothing waiting. New controllers appear here when they connect.')]));

  // Approved
  $('#approved').replaceChildren(...(approved.length ? approved.map((d) => h('tr', {},
    h('td', {}, h('b', {}, d.name)),
    h('td', { class: 'mono' }, d.id),
    h('td', {}, d.model || '—'),
    h('td', {}, dot(d.online), ' ', d.online === true ? 'Online' : d.online === false ? 'Offline' : '—'),
    h('td', {}, ago(d.lastData)),
    h('td', { class: 'acts' },
      h('a', { class: 'btn primary', href: '/#/d/' + d.dashboard }, 'Open page'), ' ',
      h('button', { class: 'btn', type: 'button', onclick: () => rename(d) }, 'Rename'), ' ',
      h('button', { class: 'btn', type: 'button', onclick: () => editLabels(d) }, 'Labels'), ' ',
      h('button', { class: 'btn', type: 'button', onclick: () => rebuild(d) }, 'Rebuild page'), ' ',
      h('button', { class: 'btn danger', type: 'button', onclick: () => remove(d) }, 'Remove')))) : [h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No approved controllers yet.'))]));

  // Profiles (one per model seen)
  const models = [...new Set(data.devices.filter((d) => d.model && d.tags.length).map((d) => d.model))];
  $('#profiles').replaceChildren(...(models.length ? models.map((m) => {
    const n = Object.keys(data.profiles[m]?.labels || {}).length, used = data.devices.filter((d) => d.model === m && d.state === 'approved').length;
    return h('div', { class: 'prof' }, h('b', {}, m), h('span', {}, `${n} friendly name${n === 1 ? '' : 's'} · used by ${used} approved controller${used === 1 ? '' : 's'}`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => editProfile(m) }, 'Edit names'));
  }) : [h('div', { class: 'empty' }, 'Profiles appear once a controller has sent its description.')]));

  $('#rejectedSec').hidden = !rejected.length;
  $('#rejected').replaceChildren(...rejected.map((d) => h('div', { class: 'rcard' },
    h('div', { class: 'rc-head' }, dot(d.online), h('h3', {}, `${d.name} (${d.id})`)),
    h('div', { class: 'rc-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => approve(d, d.name) }, 'Approve after all'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => remove(d) }, 'Forget')))));
}

function pendingCard(d) {
  const nameIn = h('input', { type: 'text', value: d.name, placeholder: 'Name for this controller', 'aria-label': 'Name' });
  const io = d.io?.m31 ? `M31 ${d.io.m31.ai} AI · ${d.io.m31.ao} AO · ${d.io.m31.di} DI · ${d.io.m31.do} DO` : '—';
  const flows = (d.io?.flowRuns || []).length;
  const preview = d.tags.filter((t) => t.telemetry).slice(0, 6).map((t) => {
    const v = values.get(`${data.prefix}/${d.id}/tag/${t.name}`);
    const n = Number(v);
    return h('div', {}, t.name, h('b', {}, v === undefined ? '—' : Number.isFinite(n) ? (+n.toFixed(2)).toString() : v, t.units ? ' ' + t.units : ''));
  });
  return h('div', { class: 'rcard new', 'data-id': d.id },
    h('div', { class: 'rc-head' }, dot(d.online), h('h3', {}, d.site?.name || d.name), h('span', { class: 'badge' }, d.id)),
    d.conflict ? h('div', { class: 'warnbox' }, `Two controllers are using ID ${d.id} (${d.clientId} and ${d.conflict.otherClientId}). Check their MACs before approving.`) : null,
    h('dl', { class: 'facts' },
      h('dt', {}, 'Model'), h('dd', {}, d.model || '—'),
      h('dt', {}, 'Product'), h('dd', {}, d.product || '—'),
      h('dt', {}, 'Firmware'), h('dd', {}, d.firmware || '—'),
      h('dt', {}, 'MAC'), h('dd', {}, d.mac || '—'),
      h('dt', {}, 'IP'), h('dd', {}, d.ip || '—'),
      h('dt', {}, 'I/O'), h('dd', {}, io + (flows ? ` · ${flows} flow run${flows > 1 ? 's' : ''}` : '')),
      h('dt', {}, 'Tags'), h('dd', {}, `${d.tagCount} (${d.telemetry ? 'telemetry every ' + d.telemetry.intervalSec + ' s' : 'no telemetry'})`),
      h('dt', {}, 'First seen'), h('dd', {}, ago(d.firstSeen))),
    preview.length ? h('div', { class: 'preview' }, ...preview) : null,
    h('div', { class: 'rc-actions' }, nameIn,
      h('button', { class: 'btn primary', type: 'button', onclick: () => approve(d, nameIn.value) }, 'Approve'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => reject(d) }, 'Reject'),
      h('a', { class: 'btn', href: `/explorer#t=${encodeURIComponent(`${data.prefix}/${d.id}/info`)}` }, 'Inspect')));
}

async function approve(d, name) {
  try {
    const r = await api(`/api/riots/${encodeURIComponent(d.id)}/approve`, { method: 'POST', body: { name: (name || '').trim() || d.name } });
    toast(`${name || d.name} approved — page created`);
    await load();
    if (confirm('Open its page now?')) location.href = '/#/d/' + r.dashboard;
  } catch (e) { toast('Approve failed: ' + e.message, 'error'); }
}
async function reject(d) {
  if (!confirm(`Reject ${d.name} (${d.id})? Its data will be ignored. You can approve it later.`)) return;
  try { await api(`/api/riots/${encodeURIComponent(d.id)}/reject`, { method: 'POST' }); load(); } catch (e) { toast(e.message, 'error'); }
}
async function rename(d) {
  const n = prompt('Name for ' + d.id, d.name); if (!n) return;
  try { await api(`/api/riots/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { name: n, rebuild: confirm('Rebuild its page with the new name? (Replaces manual edits on that page.)') } }); load(); } catch (e) { toast(e.message, 'error'); }
}
async function rebuild(d) {
  if (!confirm(`Rebuild the page for ${d.name}? Manual changes on that page are replaced.`)) return;
  try { await api(`/api/riots/${encodeURIComponent(d.id)}/rebuild`, { method: 'POST' }); toast('Page rebuilt'); } catch (e) { toast(e.message, 'error'); }
}
async function remove(d) {
  if (!confirm(`Remove ${d.name} (${d.id}) and its page? If it's still connected it will show up again as waiting for approval.`)) return;
  try { await api(`/api/riots/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'error'); }
}

// ---------- labels dialog (profile or one controller) ----------
let dlgSave = null;
function openLabels({ title, hint, colLabel, tags, current, placeholder, onSave }) {
  $('#ldTitle').textContent = title; $('#ldHint').textContent = hint; $('#ldColLabel').textContent = colLabel;
  $('#ldRows').replaceChildren(...tags.map((t) => h('tr', {},
    h('td', {}, t.name), h('td', {}, t.units || (t.type === 'digital' ? 'on/off' : '')),
    h('td', {}, h('input', { type: 'text', 'data-tag': t.name, value: current[t.name] || '', placeholder: placeholder(t) })))));
  dlgSave = onSave;
  $('#labelsDlg').showModal();
}
$('#ldSave').addEventListener('click', async () => {
  const labels = {};
  for (const i of document.querySelectorAll('#ldRows input')) if (i.value.trim()) labels[i.dataset.tag] = i.value.trim();
  try { await dlgSave(labels, $('#ldRebuild').checked); $('#labelsDlg').close(); toast('Saved'); load(); } catch (e) { toast('Not saved: ' + e.message, 'error'); }
});
for (const b of document.querySelectorAll('#labelsDlg [data-close]')) b.addEventListener('click', () => $('#labelsDlg').close());

function tagsOfModel(model) {
  const seen = new Map();
  for (const d of data.devices) if (d.model === model) for (const t of d.tags) if (!seen.has(t.name)) seen.set(t.name, t);
  return [...seen.values()];
}
function editProfile(model) {
  openLabels({
    title: `Friendly names · ${model}`,
    hint: 'These names are used on the page of every controller of this model. Leave a box empty to use the Tag name.',
    colLabel: 'Friendly name', tags: tagsOfModel(model), current: data.profiles[model]?.labels || {},
    placeholder: (t) => t.label && t.label !== t.name ? t.label : t.name,
    onSave: (labels, rebuild) => api(`/api/riot-profiles/${encodeURIComponent(model)}`, { method: 'PUT', body: { labels, rebuild } }),
  });
}
function editLabels(d) {
  const prof = data.profiles[d.model]?.labels || {};
  openLabels({
    title: `Names for ${d.name}`,
    hint: `Only for this controller. Empty boxes use the ${d.model} profile name (shown faded).`,
    colLabel: 'Name on this controller', tags: d.tags, current: d.labels || {},
    placeholder: (t) => prof[t.name] || (t.label && t.label !== t.name ? t.label : t.name),
    onSave: (labels, rebuild) => api(`/api/riots/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { labels, rebuild } }),
  });
}

load();
setInterval(load, 5000);
