// MQTT Explorer page: live topic tree, topic details, history chart, publish, clients.
import { MqttClient } from './mqtt.js';
import { h } from './widgets.js';

const $ = (s) => document.querySelector(s);
const LS = 'mqttdash.';
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------- model ----------------
const newNode = (name, path, parent) => ({ name, path, parent, children: new Map(), msg: null, total: 0, topics: 0 });
const root = newNode('', '', null);
const nodes = new Map(); // path -> node (only real topic paths and their prefixes)
const recent = new Map(); // topic -> [{t, payload, retain, qos}] newest last
const MAX_RECENT = 300;

const ui = {
  expanded: new Set(prefs.get('exExpanded', [])),
  selected: null,
  structureDirty: true,
  dirty: new Set(),
  rows: new Map(), // path -> {row, val, meta, ret, name}
  rate: 0, rateCount: 0,
  chartFields: new Set(),
  history: [], // for selected topic: [{t, payload}]
};

function getNode(topic) {
  if (nodes.has(topic)) return nodes.get(topic);
  const parts = topic.split('/');
  let n = root, path = '';
  parts.forEach((part, i) => {
    path = i === 0 ? part : path + '/' + part;
    let c = n.children.get(part);
    if (!c) {
      c = newNode(part, path, n);
      n.children.set(part, c);
      nodes.set(path, c);
      ui.structureDirty = true;
      if (i === 0 && !prefs.get('exExpandedInit', false)) ui.expanded.add(path);
    }
    n = c;
  });
  return n;
}

function ingest(topic, payload, { retain = false, qos = 0, ts = Date.now(), count = 1, live = true } = {}) {
  const n = getNode(topic);
  const isNew = !n.msg;
  // Live deliveries only carry the retain flag on subscribe, so keep the known state; an empty payload clears it.
  const wasRetained = !!n.msg?.retain;
  n.msg = { payload, ts, retain: payload === '' ? false : live ? retain || wasRetained : retain, qos, count: (n.msg?.count || 0) + count };
  if (isNew) for (let p = n; p; p = p.parent) p.topics++;
  for (let p = n; p; p = p.parent) { p.total += count; ui.dirty.add(p.path); }
  if (live) {
    let r = recent.get(topic);
    if (!r) { r = []; recent.set(topic, r); }
    r.push({ t: ts, payload, retain, qos });
    if (r.length > MAX_RECENT) r.splice(0, r.length - MAX_RECENT);
    ui.rateCount++;
    if (topic === ui.selected) { ui.history.push({ t: ts, v: payload }); detailDirty = true; }
  }
}

// ---------------- MQTT ----------------
const conn = { url: prefs.get('url', ''), username: prefs.get('username', ''), password: prefs.get('password', '') };
const defaultWsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mqtt`;
let client;
async function connect() {
  let sess = null;
  if (!conn.username && !conn.url) { try { const s = await (await fetch('/api/session', { cache: 'no-store' })).json(); if (s.password) sess = s; } catch { /* local */ } }
  client = new MqttClient({ url: conn.url || defaultWsUrl(), username: sess?.username || conn.username || undefined, password: sess?.password || conn.password || undefined, clientId: 'explorer-' + Math.random().toString(16).slice(2, 8) });
  client.addEventListener('state', (e) => {
    const { state, info } = e.detail;
    $('#conn').className = 'conn ' + state; $('#conn').title = info || state;
    $('#connText').textContent = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Offline', error: 'Error' }[state] || state;
    if (state === 'error' && info) toast(info + ' — set credentials in the dashboard ⚙ Settings', 'error');
  });
  client.addEventListener('message', (e) => { const m = e.detail; ingest(m.topic, m.payload, { retain: m.retain, qos: m.qos }); });
  client.subscribe('#', 0);
  client.subscribe('$SYS/#', 0);
  client.connect();
}

// ---------------- tree rendering ----------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);
function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function visibleSet(q, showSys) {
  const vis = new Set();
  const walk = (n) => {
    let any = false;
    for (const c of n.children.values()) {
      if (!showSys && c.path.startsWith('$SYS')) continue;
      const self = !q || c.path.toLowerCase().includes(q);
      const kids = walk(c);
      if (self || kids) { vis.add(c.path); any = true; if (self && q) addSubtree(c, vis); }
    }
    return any;
  };
  const addSubtree = (n, set) => { for (const c of n.children.values()) { set.add(c.path); addSubtree(c, set); } };
  walk(root);
  return vis;
}

function buildTree() {
  ui.structureDirty = false;
  const q = $('#filter').value.trim().toLowerCase();
  const showSys = $('#showSys').checked;
  const vis = visibleSet(q, showSys);
  ui.rows.clear();
  const make = (n) => {
    const kids = [...n.children.values()].filter((c) => vis.has(c.path)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return kids.map((c) => {
      const hasKids = c.children.size > 0;
      const open = hasKids && (ui.expanded.has(c.path) || (q && vis.has(c.path)));
      const caret = h('span', { class: 'caret' + (hasKids ? '' : ' leaf') + (open ? ' open' : '') }, '▶');
      const name = h('span', { class: 'n-name' + (c.msg ? ' has-msg' : ''), html: highlight(c.name === '' ? '(empty)' : c.name, q) });
      const val = h('span', { class: 'n-val' });
      const ret = h('span', { class: 'n-ret', title: 'retained' }, 'R');
      const meta = h('span', { class: 'n-meta' });
      const row = h('div', { class: 'node-row' + (c.path === ui.selected ? ' selected' : ''), role: 'treeitem', 'data-path': c.path }, caret, name, val, ret, meta);
      const li = h('li', {}, row);
      if (open) li.append(h('ul', { role: 'group' }, make(c)));
      ui.rows.set(c.path, { row, val, meta, ret, node: c });
      updateRow(c.path, false);
      return li;
    });
  };
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.replaceChildren(...make(root));
  if (!tree.childElementCount) tree.append(h('li', { class: 'ex-empty' }, nodes.size ? 'No topics match the filter' : 'Waiting for messages…'));
  tree.scrollTop = scroll;
  // datalist for publish box
  const topics = [...nodes.values()].filter((n) => n.msg && !n.path.startsWith('$SYS')).map((n) => n.path).sort();
  $('#topicList').replaceChildren(...topics.slice(0, 2000).map((t) => h('option', { value: t })));
}

function updateRow(path, flash = true) {
  const r = ui.rows.get(path);
  if (!r) return;
  const n = r.node;
  r.val.textContent = n.msg ? short(n.msg.payload.replace(/\s+/g, ' ')) : '';
  r.val.hidden = !n.msg;
  r.ret.hidden = !n.msg?.retain;
  r.meta.textContent = n.children.size ? `${n.topics} topic${n.topics === 1 ? '' : 's'} · ${n.total}` : n.msg ? String(n.msg.count) : '';
  if (flash && n.msg && n.children.size === 0) { r.row.classList.remove('flash'); void r.row.offsetWidth; r.row.classList.add('flash'); }
}

function flushTree() {
  if ($('#pause').checked) return;
  if (ui.structureDirty) { buildTree(); ui.dirty.clear(); return; }
  for (const p of ui.dirty) updateRow(p, true);
  ui.dirty.clear();
}

$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.node-row');
  if (!row) return;
  const path = row.dataset.path;
  const n = nodes.get(path);
  if (n.children.size && (e.target.classList.contains('caret') || !n.msg)) {
    ui.expanded.has(path) ? ui.expanded.delete(path) : ui.expanded.add(path);
    saveExpanded(); buildTree();
  }
  if (n.msg || !n.children.size) { select(path); setPane('detail'); }
});
$('#tree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.node-row'); if (!row) return;
  const path = row.dataset.path;
  ui.expanded.has(path) ? ui.expanded.delete(path) : ui.expanded.add(path);
  saveExpanded(); buildTree();
});
function saveExpanded() { prefs.set('exExpanded', [...ui.expanded].slice(0, 500)); prefs.set('exExpandedInit', true); }
$('#filter').addEventListener('input', () => { ui.structureDirty = true; flushTree(); });
$('#showSys').addEventListener('change', () => { ui.structureDirty = true; flushTree(); });
$('#pause').addEventListener('change', () => { ui.structureDirty = true; flushTree(); });
$('#expandAll').addEventListener('click', () => { for (const n of nodes.values()) if (n.children.size) ui.expanded.add(n.path); saveExpanded(); buildTree(); });
$('#collapseAll').addEventListener('click', () => { ui.expanded.clear(); saveExpanded(); buildTree(); });

// ---------------- topic detail ----------------
let detailDirty = false;
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
  return new Date(t).toLocaleString();
}
function parseJson(s) { if (!/^\s*[{[]/.test(s)) return undefined; try { return JSON.parse(s); } catch { return undefined; } }
function prettyJson(obj) {
  return esc(JSON.stringify(obj, null, 2)).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (bool) return `<span class="j-bool">${m}</span>`;
    if (m === 'null') return `<span class="j-null">null</span>`;
    return `<span class="j-num">${m}</span>`;
  });
}
function numericFields(v, prefix = '', out = []) {
  if (typeof v === 'number') out.push(prefix || 'value');
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (out.length < 12) numericFields(x, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
function getField(payload, field) {
  if (field === 'value') { const n = Number(payload); return payload.trim() !== '' && Number.isFinite(n) ? n : NaN; }
  const o = parseJson(payload); if (o === undefined) return NaN;
  let v = o; for (const k of field.split('.')) { if (v == null) return NaN; v = v[k]; }
  return typeof v === 'number' ? v : NaN;
}

async function select(path, pushHash = true) {
  ui.selected = path;
  for (const [p, r] of ui.rows) r.row.classList.toggle('selected', p === path);
  if (pushHash) history.replaceState(null, '', '#t=' + encodeURIComponent(path));
  $('#emptyTopic').hidden = true; $('#topicDetail').hidden = false;
  $('#pubTopic').value = path;
  showView('topic');
  const parts = path.split('/');
  $('#tdPath').innerHTML = parts.map((p, i) => `<span class="${i === parts.length - 1 ? 'last' : ''}">${esc(p)}</span>`).join('<span>/</span>');
  ui.chartFields.clear();
  // merge server history with what this page has seen live
  let server = [];
  if (!path.startsWith('$SYS')) { try { const r = await fetch('/api/history?topic=' + encodeURIComponent(path)); if (r.ok) server = await r.json(); } catch { /* external broker */ } }
  if (ui.selected !== path) return;
  const live = (recent.get(path) || []).map((m) => ({ t: m.t, v: m.payload, retain: m.retain }));
  const firstLive = live.length ? live[0].t : Infinity;
  ui.history = server.filter((x) => x.t < firstLive - 1000).concat(live);
  renderDetail(true);
}

function renderDetail(full) {
  detailDirty = false;
  const path = ui.selected; if (!path) return;
  const n = nodes.get(path); const m = n?.msg;
  if (!m) { $('#tdPayload').textContent = '(no message on this exact topic — it only has sub-topics)'; $('#tdMeta').textContent = ''; $('#msgs').replaceChildren(); $('#chartCard').hidden = true; return; }
  const hist = ui.history;
  const span = hist.length > 1 ? (hist[hist.length - 1].t - hist[0].t) / 1000 : 0;
  const bytes = new TextEncoder().encode(m.payload).length;
  $('#tdMeta').innerHTML = [
    ['Last message', `<span id="tdAgo">${ago(m.ts)}</span>`], ['Messages', m.count], ['QoS', m.qos], ['Retained', m.retain ? 'yes' : 'no'], ['Size', bytes + ' B'],
    span > 0 ? ['Avg interval', (span / (hist.length - 1)).toFixed(1) + ' s'] : null,
  ].filter(Boolean).map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('');
  $('#clearRetained').hidden = !m.retain;
  const obj = parseJson(m.payload);
  if (obj !== undefined && !$('#rawToggle').checked) $('#tdPayload').innerHTML = prettyJson(obj);
  else $('#tdPayload').textContent = m.payload === '' ? '(empty payload)' : m.payload;

  // chart fields
  const fields = obj !== undefined ? numericFields(obj) : Number.isFinite(Number(m.payload)) && m.payload.trim() !== '' ? ['value'] : [];
  $('#chartCard').hidden = !fields.length;
  if (fields.length) {
    if (![...ui.chartFields].some((f) => fields.includes(f))) { ui.chartFields.clear(); ui.chartFields.add(fields[0]); }
    if (full || $('#chartFields').childElementCount !== fields.length || fields.length === 1) {
      $('#chartFields').replaceChildren(...(fields.length > 1 ? fields.map((f) => h('button', { type: 'button', class: 'chip' + (ui.chartFields.has(f) ? ' on' : ''), onclick: () => { ui.chartFields.has(f) ? ui.chartFields.delete(f) : ui.chartFields.add(f); renderDetail(true); } }, f)) : []));
    }
    drawChart();
  }

  // message list (newest first)
  const list = hist.slice(-200).reverse();
  $('#msgCount').textContent = `(${hist.length} shown${hist.length >= 200 ? ', latest 200 listed' : ''})`;
  $('#msgs').replaceChildren(...list.map((x, i) => {
    const prev = list[i + 1];
    const a = Number(x.v), b = prev ? Number(prev.v) : NaN;
    let delta = '';
    if (Number.isFinite(a) && Number.isFinite(b) && x.v.trim() !== '' && a !== b) delta = h('span', { class: 'delta ' + (a > b ? 'up' : 'down') }, (a > b ? '▲ ' : '▼ ') + +(Math.abs(a - b)).toFixed(4));
    const row = h('div', { class: 'msg', title: 'Click to expand' }, h('time', {}, fmtTime(x.t)), h('span', { class: 'p' }, x.v === '' ? '(empty)' : x.v), delta || h('span'));
    row.addEventListener('click', () => row.classList.toggle('open'));
    return row;
  }));
}

// ---------------- chart ----------------
const COLORS = ['#38bdf8', '#f97316', '#a3e635', '#f472b6', '#a78bfa', '#fbbf24', '#2dd4bf', '#fb7185'];
let chartSeries = [], chartGeom = null;
function drawChart() {
  const wrap = $('.chart-wrap'), canvas = $('#chart');
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
  if (!W) return;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue('--grid').trim(), muted = css.getPropertyValue('--muted').trim();
  const winS = Number($('#chartWindow').value), now = Date.now();
  const pts = ui.history.filter((x) => !winS || x.t >= now - winS * 1000);
  chartSeries = [...ui.chartFields].map((f, i) => ({ f, color: COLORS[i % COLORS.length], data: pts.map((x) => ({ t: x.t, v: getField(x.v, f) })).filter((d) => Number.isFinite(d.v)) }));
  const all = chartSeries.flatMap((s) => s.data);
  if (!all.length) { g.fillStyle = muted; g.font = '12px system-ui'; g.fillText('No numeric data in this window', 12, 24); chartGeom = null; return; }
  const t0 = winS ? now - winS * 1000 : Math.min(...all.map((d) => d.t)), t1 = now;
  let lo = Math.min(...all.map((d) => d.v)), hi = Math.max(...all.map((d) => d.v));
  if (lo === hi) { lo -= 1; hi += 1; } else { const p = (hi - lo) * 0.08; lo -= p; hi += p; }
  const L = 54, R = 10, T = 10, B = 22;
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  chartGeom = { X, Y, L, R, W, t0, t1 };
  g.font = '11px ui-sans-serif, system-ui'; g.strokeStyle = grid; g.fillStyle = muted; g.lineWidth = 1;
  g.textAlign = 'right'; g.textBaseline = 'middle';
  const dec = hi - lo < 1 ? 3 : hi - lo < 20 ? 1 : 0;
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(v.toFixed(dec), L - 6, y); }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const nT = Math.max(1, Math.min(4, Math.floor((W - L - R) / 90)));
  for (let i = 0; i <= nT; i++) { const t = t0 + ((t1 - t0) * i) / nT; g.fillText(new Date(t).toLocaleTimeString([], { hour12: false }), Math.min(Math.max(X(t), L + 26), W - R - 26), H - 6); }
  for (const s of chartSeries) {
    g.strokeStyle = s.color; g.lineWidth = 1.8; g.lineJoin = 'round'; g.beginPath();
    s.data.forEach((d, i) => (i ? g.lineTo(X(d.t), Y(d.v)) : g.moveTo(X(d.t), Y(d.v)))); g.stroke();
    if (s.data.length < 80) { g.fillStyle = s.color; for (const d of s.data) { g.beginPath(); g.arc(X(d.t), Y(d.v), 2.5, 0, 7); g.fill(); } }
  }
}
$('#chartWindow').addEventListener('change', drawChart);
new ResizeObserver(() => { if (!$('#chartCard').hidden) drawChart(); }).observe($('.chart-wrap'));
$('#chart').addEventListener('mousemove', (e) => {
  const tip = $('#chartTip');
  if (!chartGeom) { tip.hidden = true; return; }
  const rect = e.target.getBoundingClientRect(), x = e.clientX - rect.left;
  const t = chartGeom.t0 + ((x - chartGeom.L) / (chartGeom.W - chartGeom.L - chartGeom.R)) * (chartGeom.t1 - chartGeom.t0);
  const lines = [];
  for (const s of chartSeries) {
    let best = null; for (const d of s.data) if (!best || Math.abs(d.t - t) < Math.abs(best.t - t)) best = d;
    if (best) lines.push({ s, d: best });
  }
  if (!lines.length) { tip.hidden = true; return; }
  tip.innerHTML = `<div>${fmtTime(lines[0].d.t)}</div>` + lines.map(({ s, d }) => `<div><span style="color:${s.color}">●</span> ${esc(s.f)}: <b>${d.v}</b></div>`).join('');
  tip.hidden = false;
  tip.style.left = Math.min(x + 12, rect.width - tip.offsetWidth - 4) + 'px'; tip.style.top = '8px';
});
$('#chart').addEventListener('mouseleave', () => { $('#chartTip').hidden = true; });

// ---------------- detail actions ----------------
$('#rawToggle').addEventListener('change', () => renderDetail(false));
$('#copyTopic').addEventListener('click', () => copy(ui.selected));
$('#copyPayload').addEventListener('click', () => copy(nodes.get(ui.selected)?.msg?.payload ?? ''));
$('#clearRetained').addEventListener('click', () => {
  if (!confirm(`Clear the retained message on "${ui.selected}"?`)) return;
  if (client.publish(ui.selected, '', { retain: true })) { const n = nodes.get(ui.selected); if (n.msg) n.msg.retain = false; renderDetail(false); updateRow(ui.selected, false); toast('Retained message cleared'); }
});
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed', 'error'); } }

// ---------------- views & clients ----------------
function showView(v) {
  for (const b of document.querySelectorAll('.subtab')) b.classList.toggle('active', b.dataset.view === v);
  $('#viewTopic').hidden = v !== 'topic'; $('#viewClients').hidden = v !== 'clients';
  if (v === 'clients') loadClients();
}
for (const b of document.querySelectorAll('.subtab')) b.addEventListener('click', () => showView(b.dataset.view));

async function loadClients() {
  try {
    const list = await (await fetch('/api/clients')).json();
    $('#clientBadge').textContent = list.length;
    if ($('#viewClients').hidden) return;
    $('#clients').replaceChildren(...list.sort((a, b) => a.clientId.localeCompare(b.clientId)).map((c) => h('tr', {},
      h('td', { class: 'mono' }, c.clientId), h('td', {}, c.username || '—'), h('td', {}, c.transport === 'ws' ? 'WebSocket' : 'TCP'),
      h('td', { class: 'mono' }, c.remote || ''), h('td', { title: c.connectedAt ? new Date(c.connectedAt).toLocaleString() : '' }, c.connectedAt ? ago(c.connectedAt).replace(' ago', '') : '—'),
      h('td', {}, String(c.messagesIn ?? '—')), h('td', {}, c.subscriptions.length ? c.subscriptions.map((s) => h('span', { class: 'sub' }, s)) : '—'))));
    if (!list.length) $('#clients').append(h('tr', {}, h('td', { colspan: 7 }, 'No clients connected')));
  } catch { /* not the built-in broker */ }
}

async function loadInfo() {
  try {
    const i = await (await fetch('/api/info')).json();
    $('#stClients').textContent = i.clients; $('#stRetained').textContent = i.retained;
    const u = i.uptime; $('#stUptime').textContent = u < 3600 ? Math.floor(u / 60) + 'm' : u < 86400 ? Math.floor(u / 3600) + 'h ' + Math.floor((u % 3600) / 60) + 'm' : Math.floor(u / 86400) + 'd ' + Math.floor((u % 86400) / 3600) + 'h';
  } catch { /* ignore */ }
  $('#stTopics').textContent = [...nodes.values()].filter((n) => n.msg && !n.path.startsWith('$SYS')).length;
}

// ---------------- publish ----------------
function renderPubHistory() {
  const items = prefs.get('pubHistory', []);
  $('#pubHistory').replaceChildren(...(items.length ? items.map((it) => h('button', { type: 'button', title: `${it.topic}\n${it.payload}`, onclick: () => { $('#pubTopic').value = it.topic; $('#pubPayload').value = it.payload; $('#pubRetain').checked = !!it.retain; $('#pubQos').value = it.qos || 0; } }, h('b', {}, it.topic), ' ', short(it.payload, 40))) : [h('small', { class: 'hint' }, 'Messages you publish appear here.')]));
}
$('#pubForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const topic = $('#pubTopic').value.trim(), payload = $('#pubPayload').value, retain = $('#pubRetain').checked, qos = Number($('#pubQos').value);
  if (!topic || /[+#]/.test(topic)) { toast('Enter a topic without wildcards', 'error'); return; }
  if (!client.publish(topic, payload, { retain, qos })) { toast('Not connected', 'error'); return; }
  toast(`Published to ${topic}`);
  const hist = prefs.get('pubHistory', []).filter((x) => !(x.topic === topic && x.payload === payload));
  hist.unshift({ topic, payload, retain, qos }); prefs.set('pubHistory', hist.slice(0, 12)); renderPubHistory();
});
$('#fmtJson').addEventListener('click', () => { try { $('#pubPayload').value = JSON.stringify(JSON.parse($('#pubPayload').value), null, 2); } catch { toast('Payload is not valid JSON', 'error'); } });

// ---------------- misc ----------------
function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2400); setTimeout(() => t.remove(), 2800);
}
function applyTheme(t) { document.documentElement.dataset.theme = t; }
$('#themeBtn').addEventListener('click', () => { const t = prefs.get('theme', 'dark') === 'dark' ? 'light' : 'dark'; prefs.set('theme', t); applyTheme(t); if (!$('#chartCard').hidden) drawChart(); });

async function refreshRetained() {
  try {
    for (const t of await (await fetch('/api/topics')).json()) { const n = nodes.get(t.topic); if (n?.msg && n.msg.retain !== !!t.retained) { n.msg.retain = !!t.retained; ui.dirty.add(t.topic); } }
  } catch { /* ignore */ }
}

// ---------------- phone panes ----------------
function setPane(p) {
  document.body.dataset.pane = p;
  for (const b of document.querySelectorAll('.ex-mnav button')) b.classList.toggle('active', b.dataset.pane === p);
  if (p === 'detail' && !$('#chartCard').hidden) requestAnimationFrame(drawChart);
}
for (const b of document.querySelectorAll('[data-pane]')) if (b.tagName === 'BUTTON') b.addEventListener('click', () => setPane(b.dataset.pane));

// ---------------- boot ----------------
(async function main() {
  applyTheme(prefs.get('theme', 'dark'));
  renderPubHistory();
  try {
    const topics = await (await fetch('/api/topics')).json();
    for (const t of topics) ingest(t.topic, t.payload ?? '', { retain: !!t.retained, ts: t.ts, count: t.count || 1, live: false });
  } catch { /* external broker */ }
  buildTree();
  connect();
  setInterval(flushTree, 300);
  setInterval(() => { if (detailDirty && ui.selected) renderDetail(false); }, 400);
  setInterval(() => { const a = $('#tdAgo'); const m = nodes.get(ui.selected)?.msg; if (a && m) a.textContent = ago(m.ts); }, 1000);
  setInterval(() => { $('#stRate').textContent = ui.rateCount; ui.rateCount = 0; }, 1000);
  setInterval(() => { loadInfo(); loadClients(); }, 5000);
  setInterval(refreshRetained, 30000);
  loadInfo(); loadClients();
  const m = location.hash.match(/^#t=(.+)$/);
  if (m) { const p = decodeURIComponent(m[1]); if (nodes.has(p)) { for (let n = nodes.get(p).parent; n && n.path; n = n.parent) ui.expanded.add(n.path); buildTree(); select(p, false); } }
})();
