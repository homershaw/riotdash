import { MqttClient, topicMatches } from './mqtt.js';
import { WIDGETS, h, widgetTopics, parseSeries } from './widgets.js';
import { initUpdates } from './update.js';

const $ = (sel, root = document) => root.querySelector(sel);
const LS = 'mqttdash.';
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------- state ----------------
const state = {
  dashboards: [],
  dash: null,
  edit: false,
  selected: new Set(),
  instances: new Map(), // id -> { el, body, inst, filters }
  cache: new Map(), // topic -> { payload, ts, count }
  undo: [], redo: [],
  explorerDirty: true,
  selectedTopic: null,
  viewMode: prefs.get('viewMode', 'auto'),
  canvasW: 0, canvasH: 0,
};

const defaultWsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mqtt`;
const conn = { url: prefs.get('url', ''), username: prefs.get('username', ''), password: prefs.get('password', ''), subscribeAll: prefs.get('subscribeAll', true) };
let client;

// ---------------- MQTT ----------------
// When opened over the internet (logged in through the browser), the server hands out an MQTT session login.
async function sessionLogin() {
  if (conn.username || conn.url) return null;
  try { const s = await (await fetch('/api/session', { cache: 'no-store' })).json(); return s.password ? s : null; } catch { return null; }
}

let sessionRetried = false;
async function connect() {
  if (client) client.disconnect();
  const sess = await sessionLogin();
  client = new MqttClient({ url: conn.url || defaultWsUrl(), username: sess?.username || conn.username || undefined, password: sess?.password || conn.password || undefined });
  client.addEventListener('state', (e) => {
    if (e.detail.state === 'connected') sessionRetried = false;
    // an expired session login: fetch a fresh one once
    if (e.detail.state === 'error' && sess && !sessionRetried) { sessionRetried = true; connect(); return; }
    setConnState(e.detail.state, e.detail.info);
  });
  client.addEventListener('message', (e) => onMessage(e.detail.topic, e.detail.payload));
  syncSubscriptions();
  client.connect();
}

function setConnState(st, info) {
  const el = $('#conn');
  el.className = 'conn ' + st;
  el.title = info || st;
  $('#connText').textContent = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Offline', error: 'Error' }[st] || st;
  if (st === 'error' && info) toast(info, 'error');
}

function syncSubscriptions() {
  if (!client) return;
  const want = new Set();
  if (conn.subscribeAll) want.add('#');
  for (const w of state.dash?.widgets || []) {
    for (const f of widgetTopics(w)) {
      if (conn.subscribeAll && !f.startsWith('$')) continue; // already covered by '#'
      want.add(f);
    }
  }
  for (const f of [...client.subs.keys()]) if (!want.has(f)) client.unsubscribe(f);
  for (const f of want) client.subscribe(f, 0);
}

function onMessage(topic, payload) {
  const c = state.cache.get(topic) || { count: 0 };
  c.payload = payload; c.ts = Date.now(); c.count++;
  state.cache.set(topic, c);
  state.explorerDirty = true;
  for (const rec of state.instances.values()) {
    if (rec.inst?.onMessage && rec.filters.some((f) => topicMatches(f, topic))) {
      try { rec.inst.onMessage(topic, payload); } catch (e) { console.error(e); }
    }
  }
}

const api = {
  publish(topic, payload, opts) {
    if (!topic) { toast('No command topic configured', 'error'); return; }
    if (!client.publish(topic, payload, opts)) toast('Not connected to broker', 'error');
  },
  async history(topic) {
    if (topic.includes('+') || topic.includes('#')) return [];
    try { const r = await fetch('/api/history?topic=' + encodeURIComponent(topic)); return r.ok ? r.json() : []; } catch { return []; }
  },
  confirm: (msg) => window.confirm(msg),
};

// ---------------- dashboards ----------------
async function loadDashboards() {
  state.dashboards = await (await fetch('/api/dashboards')).json();
  const sel = $('#dashSelect');
  sel.replaceChildren(...state.dashboards.map((d) => h('option', { value: d.id }, d.name)));
}

async function openDashboard(id) {
  if (!id) id = state.dashboards[0]?.id;
  if (!id) { await newDashboard('My dashboard'); return; }
  const r = await fetch('/api/dashboards/' + encodeURIComponent(id));
  if (!r.ok) { if (state.dashboards[0] && state.dashboards[0].id !== id) return openDashboard(state.dashboards[0].id); return; }
  state.dash = normalise(await r.json());
  state.selected.clear(); state.undo = []; state.redo = [];
  $('#dashSelect').value = id;
  prefs.set('lastDash', id);
  if (location.hash !== '#/d/' + id) history.replaceState(null, '', '#/d/' + id);
  document.title = state.dash.name + ' · MQTT Dash';
  renderAll();
}

function normalise(d) {
  d.widgets = (d.widgets || []).filter((w) => WIDGETS[w.type]).map((w) => ({ ...w, props: { ...WIDGETS[w.type].defaults, frame: WIDGETS[w.type].frame, label: '', ...w.props } }));
  d.settings = { grid: 10, background: '', width: 1600, height: 900, ...(d.settings || {}) };
  return d;
}

let saveTimer;
function save(immediate) {
  clearTimeout(saveTimer);
  $('#saveState').textContent = 'Unsaved';
  const doSave = async () => {
    try {
      const r = await fetch('/api/dashboards/' + state.dash.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.dash) });
      $('#saveState').textContent = r.ok ? 'Saved' : 'Save failed';
    } catch { $('#saveState').textContent = 'Save failed'; }
  };
  if (immediate) return doSave();
  saveTimer = setTimeout(doSave, 600);
}

// Record an undo point *before* a mutation
function checkpoint() {
  state.undo.push(JSON.stringify(state.dash.widgets));
  if (state.undo.length > 80) state.undo.shift();
  state.redo = [];
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.dash.widgets));
  state.dash.widgets = JSON.parse(state.undo.pop());
  state.selected.clear(); renderAll(); save();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.dash.widgets));
  state.dash.widgets = JSON.parse(state.redo.pop());
  state.selected.clear(); renderAll(); save();
}

async function newDashboard(name) {
  const r = await fetch('/api/dashboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, widgets: [] }) });
  const d = await r.json();
  await loadDashboards();
  await openDashboard(d.id);
  setEdit(true);
}

// ---------------- rendering ----------------
const canvas = () => $('#canvas');
const uid = () => 'w' + Math.random().toString(36).slice(2, 9);
const snap = (v) => { const g = state.dash.settings.grid || 1; return Math.round(v / g) * g; };

function renderAll() {
  for (const rec of state.instances.values()) rec.inst?.destroy?.();
  state.instances.clear();
  const c = canvas();
  c.replaceChildren();
  const st = state.dash.settings;
  c.style.background = st.background || '';
  c.style.setProperty('--grid', (st.grid || 10) + 'px');
  for (const w of state.dash.widgets) c.append(buildWidget(w));
  sizeCanvas();
  syncSubscriptions();
  renderProps();
}

function sizeCanvas() {
  const st = state.dash.settings;
  let W = st.width || 1200, H = st.height || 800;
  for (const w of state.dash.widgets) { W = Math.max(W, w.x + w.w + 40); H = Math.max(H, w.y + w.h + 40); }
  canvas().style.width = W + 'px';
  canvas().style.height = H + 'px';
  state.canvasW = W; state.canvasH = H;
  applyLayout();
}

// ---------------- responsive layout ----------------
function effectiveMode() {
  if (state.edit) return 'actual';
  if (state.viewMode !== 'auto') return state.viewMode;
  if (window.innerWidth < 700) return 'stack';
  return state.canvasW > $('#stage').clientWidth ? 'fit' : 'actual';
}

function applyLayout() {
  if (!state.dash) return;
  const mode = effectiveMode();
  const c = canvas(), sz = $('#sizer');
  document.body.dataset.layout = mode;
  c.classList.toggle('stack', mode === 'stack');
  if (mode === 'stack') {
    c.style.transform = ''; sz.style.width = ''; sz.style.height = '';
    const has = (w) => w.props.mobileOrder !== '' && w.props.mobileOrder !== undefined && w.props.mobileOrder !== null;
    const order = [...state.dash.widgets].sort((a, b) => (has(a) && has(b) ? a.props.mobileOrder - b.props.mobileOrder : has(a) ? -1 : has(b) ? 1 : a.y - b.y || a.x - b.x));
    order.forEach((w, i) => {
      const r = state.instances.get(w.id); if (!r) return;
      const hide = w.props.mobileHide || w.type === 'pipe' || w.type === 'image' || (w.type === 'label' && !String(w.props.text || '').trim() && !w.props.topic);
      r.el.style.order = i;
      r.el.classList.toggle('m-hide', !!hide);
      r.el.classList.toggle('m-wide', w.w >= 300 || ['label', 'trend', 'log', 'slider', 'input', 'bar'].includes(w.type));
      const cap = ['trend', 'log'].includes(w.type) ? 300 : 240;
      r.el.style.setProperty('--sh', Math.min(Math.max(w.h, 48), cap) + 'px');
    });
  } else {
    for (const r of state.instances.values()) r.el.style.order = '';
    const scale = mode === 'fit' ? Math.min(1, ($('#stage').clientWidth - 2) / (state.canvasW || 1)) : 1;
    c.style.transform = scale < 1 ? `scale(${scale})` : '';
    sz.style.width = state.canvasW * scale + 'px';
    sz.style.height = state.canvasH * scale + 'px';
  }
}

function buildWidget(w) {
  const def = WIDGETS[w.type];
  const p = w.props;
  const el = h('div', { class: `widget w-${w.type}${p.frame ? ' framed' : ''}${state.selected.has(w.id) ? ' selected' : ''}`, 'data-id': w.id });
  placeEl(el, w);
  if (p.label && !def.noTitle) el.append(h('div', { class: 'w-title' }, p.label));
  const body = h('div', { class: 'w-body' });
  el.append(body, h('div', { class: 'w-resize', title: 'Resize' }));
  let inst = {};
  try { inst = def.create(body, p, api) || {}; } catch (e) { console.error(e); body.append(h('div', { class: 'empty-hint' }, 'Widget error: ' + e.message)); }
  const filters = widgetTopics(w);
  state.instances.set(w.id, { el, body, inst, filters });
  // Replay last known values so a freshly built widget isn't blank
  if (inst.onMessage) {
    for (const [topic, c] of state.cache) if (filters.some((f) => topicMatches(f, topic))) { try { inst.onMessage(topic, c.payload); } catch { /* ignore */ } }
  }
  return el;
}

function placeEl(el, w) { Object.assign(el.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' }); }

function rebuildWidget(id) {
  const w = findW(id);
  const old = state.instances.get(id);
  old?.inst?.destroy?.();
  const el = buildWidget(w);
  old ? old.el.replaceWith(el) : canvas().append(el);
  syncSubscriptions();
}

const findW = (id) => state.dash.widgets.find((w) => w.id === id);

function addWidget(type, x, y, props = {}) {
  const def = WIDGETS[type];
  checkpoint();
  const w = { id: uid(), type, x: Math.max(0, snap(x)), y: Math.max(0, snap(y)), w: def.size[0], h: def.size[1],
    props: { ...structuredClone(def.defaults), frame: def.frame, label: def.noTitle ? '' : def.label, ...props } };
  state.dash.widgets.push(w);
  canvas().append(buildWidget(w));
  select([w.id]);
  sizeCanvas(); syncSubscriptions(); save();
  return w;
}

function deleteSelected() {
  if (!state.selected.size) return;
  checkpoint();
  for (const id of state.selected) { const r = state.instances.get(id); r?.inst?.destroy?.(); r?.el.remove(); state.instances.delete(id); }
  state.dash.widgets = state.dash.widgets.filter((w) => !state.selected.has(w.id));
  state.selected.clear();
  renderProps(); syncSubscriptions(); save();
}

function duplicateSelected() {
  if (!state.selected.size) return;
  checkpoint();
  const g = state.dash.settings.grid || 10;
  const ids = [];
  for (const id of state.selected) {
    const w = structuredClone(findW(id));
    w.id = uid(); w.x += g * 2; w.y += g * 2;
    state.dash.widgets.push(w); canvas().append(buildWidget(w)); ids.push(w.id);
  }
  select(ids); sizeCanvas(); syncSubscriptions(); save();
}

function reorder(toFront) {
  if (!state.selected.size) return;
  checkpoint();
  const sel = state.dash.widgets.filter((w) => state.selected.has(w.id));
  const rest = state.dash.widgets.filter((w) => !state.selected.has(w.id));
  state.dash.widgets = toFront ? [...rest, ...sel] : [...sel, ...rest];
  renderAll(); save();
}

function select(ids, additive) {
  if (!additive) state.selected.clear();
  for (const id of ids) state.selected.add(id);
  for (const [id, r] of state.instances) r.el.classList.toggle('selected', state.selected.has(id));
  renderProps();
}

// ---------------- edit interactions ----------------
function setEdit(on) {
  state.edit = on;
  document.body.classList.toggle('editing', on);
  $('#editBtn').textContent = on ? 'Done' : 'Edit';
  $('#editBtn').classList.toggle('primary', on);
  if (!on) select([]);
  renderProps();
  applyLayout();
}

function initCanvasInteractions() {
  const c = canvas();
  let drag = null;

  c.addEventListener('pointerdown', (e) => {
    if (!state.edit || e.button !== 0) return;
    const wEl = e.target.closest('.widget');
    if (!wEl) { select([]); return; }
    const id = wEl.dataset.id;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (state.selected.has(id)) { state.selected.delete(id); select([...state.selected]); return; }
      select([id], true);
    } else if (!state.selected.has(id)) select([id]);
    const resizing = e.target.classList.contains('w-resize');
    const items = (resizing ? [id] : [...state.selected]).map((sid) => ({ w: findW(sid), x: findW(sid).x, y: findW(sid).y, ww: findW(sid).w, hh: findW(sid).h }));
    drag = { sx: e.clientX, sy: e.clientY, resizing, items, moved: false };
    c.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  c.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (!drag.moved) { checkpoint(); drag.moved = true; }
    for (const it of drag.items) {
      if (drag.resizing) { it.w.w = Math.max(20, snap(it.ww + dx)); it.w.h = Math.max(20, snap(it.hh + dy)); }
      else { it.w.x = Math.max(0, snap(it.x + dx)); it.w.y = Math.max(0, snap(it.y + dy)); }
      placeEl(state.instances.get(it.w.id).el, it.w);
    }
    renderGeometry();
  });

  const end = () => {
    if (!drag) return;
    if (drag.moved) { sizeCanvas(); save(); }
    drag = null;
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);

  // Drag & drop from palette / topic explorer
  c.addEventListener('dragover', (e) => {
    if (!state.edit) return;
    if ([...e.dataTransfer.types].some((t) => t === 'application/x-widget' || t === 'application/x-topic')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const wEl = e.target.closest('.widget');
      c.querySelectorAll('.drop-target').forEach((x) => x !== wEl && x.classList.remove('drop-target'));
      if (wEl && e.dataTransfer.types.includes('application/x-topic')) wEl.classList.add('drop-target');
    }
  });
  c.addEventListener('dragleave', (e) => { if (!c.contains(e.relatedTarget)) c.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target')); });
  c.addEventListener('drop', (e) => {
    if (!state.edit) return;
    e.preventDefault();
    c.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const type = e.dataTransfer.getData('application/x-widget');
    const topic = e.dataTransfer.getData('application/x-topic');
    if (type && WIDGETS[type]) { const [ww, hh] = WIDGETS[type].size; addWidget(type, x - ww / 2, y - hh / 2); return; }
    if (topic) {
      const wEl = e.target.closest('.widget');
      if (wEl) bindTopic(findW(wEl.dataset.id), topic);
      else {
        const last = state.cache.get(topic)?.payload ?? '';
        const isNum = last !== '' && !Number.isNaN(Number(last));
        const isJson = /^\s*[{[]/.test(last);
        addWidget(isNum || isJson ? 'value' : 'status', x - 90, y - 50, { topic, label: topic.split('/').slice(-2).join(' / '), ...(isJson ? {} : !isNum ? { states: '' } : {}) });
      }
    }
  });
}

function bindTopic(w, topic) {
  checkpoint();
  if (w.type === 'trend') {
    const existing = parseSeries(w.props.series).map((s) => s.topic);
    if (!existing.includes(topic)) w.props.series = (w.props.series ? w.props.series.trim() + '\n' : '') + topic;
  } else if (WIDGETS[w.type].fields.some((f) => f.key === 'topic')) w.props.topic = topic;
  else if ('commandTopic' in w.props) w.props.commandTopic = topic;
  else return;
  rebuildWidget(w.id); select([w.id]); save();
  toast(`Bound ${topic} → ${w.props.label || WIDGETS[w.type].label}`);
}

function renderGeometry() {
  if (state.selected.size !== 1) return;
  const w = findW([...state.selected][0]);
  for (const k of ['x', 'y', 'w', 'h']) { const i = $(`#props [data-geo="${k}"]`); if (i && document.activeElement !== i) i.value = w[k]; }
}

// ---------------- properties panel ----------------
function renderProps() {
  const panel = $('#props');
  if (!state.edit) { panel.hidden = true; return; }
  panel.hidden = false;
  const body = $('#propsBody');
  if (state.selected.size === 0) {
    const st = state.dash.settings;
    body.replaceChildren(
      h('h3', {}, 'Dashboard'),
      field('Name', h('input', { type: 'text', value: state.dash.name, onchange: (e) => { state.dash.name = e.target.value || 'Untitled'; save(); loadDashboards().then(() => ($('#dashSelect').value = state.dash.id)); } })),
      field('Grid size (px)', h('input', { type: 'number', min: 1, value: st.grid, onchange: (e) => { st.grid = Math.max(1, +e.target.value || 10); canvas().style.setProperty('--grid', st.grid + 'px'); save(); } })),
      field('Canvas width', h('input', { type: 'number', value: st.width, onchange: (e) => { st.width = +e.target.value || 1200; sizeCanvas(); save(); } })),
      field('Canvas height', h('input', { type: 'number', value: st.height, onchange: (e) => { st.height = +e.target.value || 800; sizeCanvas(); save(); } })),
      field('Background', colorInput(st.background || '', (v) => { st.background = v; canvas().style.background = v; save(); })),
      h('p', { class: 'hint' }, 'Drag widgets from the palette onto the canvas. Drag a topic onto a widget to bind it, or onto empty space to create a value display. Shift-click to multi-select. Del deletes, Ctrl+D duplicates, arrows nudge, Ctrl+Z undoes.'),
    );
    return;
  }
  if (state.selected.size > 1) {
    body.replaceChildren(h('h3', {}, `${state.selected.size} widgets selected`), actionsRow(),
      h('div', { class: 'align-row' },
        ...[['Align left', 'x', 'min'], ['Align top', 'y', 'min'], ['Align right', 'x', 'max'], ['Align bottom', 'y', 'max']].map(([t, k, m]) => h('button', { class: 'btn', type: 'button', onclick: () => align(k, m) }, t))));
    return;
  }
  const w = findW([...state.selected][0]);
  if (!w) return;
  const def = WIDGETS[w.type];
  const update = (k, v, rebuild = true) => { checkpoint(); w.props[k] = v; if (rebuild) rebuildWidget(w.id); save(); };
  const els = [h('h3', {}, h('span', { class: 'ptype', html: def.icon }), def.label)];
  if (!def.noTitle) els.push(field('Title', h('input', { type: 'text', value: w.props.label || '', onchange: (e) => update('label', e.target.value) })));
  els.push(field('', h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!w.props.frame, onchange: (e) => update('frame', e.target.checked) }), ' Show card frame')));
  for (const f of def.fields) els.push(propField(f, w, update));
  els.push(h('h4', {}, 'Phone (list) view'),
    field('', h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!w.props.mobileHide, onchange: (e) => update('mobileHide', e.target.checked, false) }), ' Hide in list view')),
    field('List order', h('input', { type: 'number', value: w.props.mobileOrder ?? '', placeholder: 'auto (top-to-bottom)', onchange: (e) => update('mobileOrder', e.target.value === '' ? '' : Number(e.target.value), false) }), 'Lower numbers come first; blank follows the canvas position.'));
  els.push(h('h4', {}, 'Position & size'),
    h('div', { class: 'geo' }, ...['x', 'y', 'w', 'h'].map((k) => h('label', {}, k.toUpperCase(), h('input', { type: 'number', 'data-geo': k, value: w[k], onchange: (e) => { checkpoint(); w[k] = Math.max(k === 'w' || k === 'h' ? 10 : 0, +e.target.value || 0); placeEl(state.instances.get(w.id).el, w); sizeCanvas(); save(); } })))),
    actionsRow());
  body.replaceChildren(...els);
}

function align(k, m) {
  checkpoint();
  const ws = [...state.selected].map(findW);
  const size = k === 'x' ? 'w' : 'h';
  const target = m === 'min' ? Math.min(...ws.map((w) => w[k])) : Math.max(...ws.map((w) => w[k] + w[size]));
  for (const w of ws) { w[k] = m === 'min' ? target : target - w[size]; placeEl(state.instances.get(w.id).el, w); }
  save();
}

function actionsRow() {
  return h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'button', onclick: duplicateSelected }, 'Duplicate'),
    h('button', { class: 'btn', type: 'button', onclick: () => reorder(true) }, 'To front'),
    h('button', { class: 'btn', type: 'button', onclick: () => reorder(false) }, 'To back'),
    h('button', { class: 'btn danger', type: 'button', onclick: deleteSelected }, 'Delete'));
}

function field(label, input, hint) {
  return h('div', { class: 'field' }, label ? h('label', {}, label) : null, input, hint ? h('small', {}, hint) : null);
}

function colorInput(value, onChange) {
  const text = h('input', { type: 'text', value, placeholder: '#rrggbb' });
  const pick = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000' });
  pick.addEventListener('input', () => { text.value = pick.value; onChange(pick.value); });
  text.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) pick.value = text.value; onChange(text.value); });
  return h('div', { class: 'color-row' }, pick, text);
}

function propField(f, w, update) {
  const v = w.props[f.key];
  let input;
  if (f.type === 'checkbox') return field('', h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!v, onchange: (e) => update(f.key, e.target.checked) }), ' ' + f.label), f.hint);
  if (f.type === 'select') input = h('select', { onchange: (e) => update(f.key, e.target.value) }, ...f.options.map((o) => h('option', { value: o, selected: o === v }, o)));
  else if (f.type === 'textarea') input = h('textarea', { rows: 4, onchange: (e) => update(f.key, e.target.value) }, v ?? '');
  else if (f.type === 'color') input = colorInput(v ?? '', (val) => update(f.key, val));
  else if (f.type === 'number') input = h('input', { type: 'number', step: 'any', value: v ?? '', onchange: (e) => update(f.key, e.target.value === '' ? '' : Number(e.target.value)) });
  else input = h('input', { type: 'text', value: v ?? '', list: f.type === 'topic' ? 'topicList' : null, onchange: (e) => update(f.key, e.target.value) });
  if (f.type === 'topic' || f.type === 'textarea') {
    const target = input;
    target.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-topic')) e.preventDefault(); });
    target.addEventListener('drop', (e) => {
      const t = e.dataTransfer.getData('application/x-topic'); if (!t) return;
      e.preventDefault(); e.stopPropagation();
      update(f.key, f.type === 'textarea' ? ((target.value.trim() ? target.value.trim() + '\n' : '') + t) : t);
      renderProps();
    });
  }
  return field(f.label, input, f.hint);
}

// ---------------- palette & topic explorer ----------------
function renderPalette() {
  const groups = {};
  for (const [type, def] of Object.entries(WIDGETS)) (groups[def.group] ||= []).push([type, def]);
  const pal = $('#palette');
  pal.replaceChildren(...Object.entries(groups).map(([g, items]) => h('div', { class: 'pal-group' }, h('div', { class: 'pal-title' }, g),
    h('div', { class: 'pal-items' }, ...items.map(([type, def]) => {
      const it = h('div', { class: 'pal-item', draggable: 'true', title: `Drag ${def.label} onto the canvas`, html: def.icon });
      it.append(h('span', {}, def.label));
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-widget', type); e.dataTransfer.effectAllowed = 'copy'; });
      it.addEventListener('dblclick', () => { const sc = $('#stage'); addWidget(type, sc.scrollLeft + 60, sc.scrollTop + 60); });
      return it;
    })))));
}

function renderExplorer() {
  if (!state.explorerDirty) return;
  state.explorerDirty = false;
  const q = $('#topicFilter').value.trim().toLowerCase();
  const list = $('#topics');
  const topics = [...state.cache.keys()].filter((t) => (!t.startsWith('$SYS') || q.startsWith('$')) && t.toLowerCase().includes(q)).sort();
  $('#topicCount').textContent = topics.length;
  const now = Date.now();
  list.replaceChildren(...topics.slice(0, 500).map((t) => {
    const c = state.cache.get(t);
    const fresh = now - c.ts < 1500;
    const row = h('div', { class: 'topic' + (t === state.selectedTopic ? ' active' : '') + (fresh ? ' fresh' : ''), draggable: 'true', title: t },
      h('div', { class: 't-name' }, t), h('div', { class: 't-val' }, c.payload.length > 60 ? c.payload.slice(0, 60) + '…' : c.payload));
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-topic', t); e.dataTransfer.setData('text/plain', t); e.dataTransfer.effectAllowed = 'copy'; });
    row.addEventListener('click', () => { state.selectedTopic = t; $('#pubTopic').value = t; state.explorerDirty = true; renderExplorer(); });
    return row;
  }));
  const dl = $('#topicList');
  if (dl.childElementCount !== topics.length) dl.replaceChildren(...topics.map((t) => h('option', { value: t })));
}

async function seedTopics() {
  try {
    const r = await fetch('/api/topics');
    if (!r.ok) return;
    for (const t of await r.json()) if (!state.cache.has(t.topic)) state.cache.set(t.topic, { payload: t.payload, ts: t.ts, count: t.count });
    state.explorerDirty = true;
  } catch { /* external broker or offline */ }
}

// ---------------- misc UI ----------------
function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

function openSettings() {
  const d = $('#settingsDlg');
  $('#setUrl').value = conn.url; $('#setUrl').placeholder = defaultWsUrl();
  $('#setUser').value = conn.username; $('#setPass').value = conn.password;
  $('#setAll').checked = conn.subscribeAll;
  $('#setTheme').value = prefs.get('theme', 'dark');
  d.showModal();
}

function applyTheme(t) { document.documentElement.dataset.theme = t; }

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

function initUI() {
  $('#dashSelect').addEventListener('change', (e) => openDashboard(e.target.value));
  $('#viewMode').value = state.viewMode;
  $('#viewMode').addEventListener('change', (e) => { state.viewMode = e.target.value; prefs.set('viewMode', state.viewMode); applyLayout(); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(applyLayout, 120); });
  $('#editBtn').addEventListener('click', () => setEdit(!state.edit));
  $('#newBtn').addEventListener('click', () => { const n = prompt('Name for the new dashboard:', 'New dashboard'); if (n) newDashboard(n); });
  $('#delBtn').addEventListener('click', async () => {
    if (!confirm(`Delete dashboard "${state.dash.name}"? This cannot be undone.`)) return;
    await fetch('/api/dashboards/' + state.dash.id, { method: 'DELETE' });
    await loadDashboards(); openDashboard(state.dashboards[0]?.id);
  });
  $('#exportBtn').addEventListener('click', () => download(`${state.dash.id}.dashboard.json`, JSON.stringify(state.dash, null, 2)));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text()); delete d.id;
      const r = await fetch('/api/dashboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...d, name: (d.name || 'Imported') + ' (imported)' }) });
      const nd = await r.json(); await loadDashboards(); openDashboard(nd.id); toast('Dashboard imported');
    } catch (err) { toast('Import failed: ' + err.message, 'error'); }
    e.target.value = '';
  });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    conn.url = $('#setUrl').value.trim(); conn.username = $('#setUser').value; conn.password = $('#setPass').value; conn.subscribeAll = $('#setAll').checked;
    for (const k of ['url', 'username', 'password', 'subscribeAll']) prefs.set(k, conn[k]);
    prefs.set('theme', $('#setTheme').value); applyTheme($('#setTheme').value);
    connect();
  });
  $('#topicsToggle').addEventListener('click', () => { document.body.classList.toggle('show-left'); prefs.set('showLeft', document.body.classList.contains('show-left')); });
  $('#fullBtn').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
  $('#topicFilter').addEventListener('input', () => { state.explorerDirty = true; renderExplorer(); });
  $('#pubForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#pubTopic').value.trim();
    if (!t) return;
    api.publish(t, $('#pubPayload').value, { retain: $('#pubRetain').checked });
  });

  document.addEventListener('keydown', (e) => {
    if (!state.edit) return;
    if (e.target.closest('input, textarea, select, dialog')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); select(state.dash.widgets.map((w) => w.id)); }
    else if (e.key === 'Escape') select([]);
    else if (e.key.startsWith('Arrow') && state.selected.size) {
      e.preventDefault();
      const step = e.shiftKey ? (state.dash.settings.grid || 10) * 5 : (state.dash.settings.grid || 10);
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      checkpoint();
      for (const id of state.selected) { const w = findW(id); w.x = Math.max(0, w.x + dx); w.y = Math.max(0, w.y + dy); placeEl(state.instances.get(id).el, w); }
      renderGeometry(); sizeCanvas(); save();
    }
  });
  window.addEventListener('hashchange', () => { const m = location.hash.match(/^#\/d\/(.+)$/); if (m && m[1] !== state.dash?.id) openDashboard(m[1]); });
  setInterval(renderExplorer, 500);
}

// ---------------- boot ----------------
(async function main() {
  applyTheme(prefs.get('theme', 'dark'));
  if (prefs.get('showLeft', false)) document.body.classList.add('show-left');
  initUI();
  initUpdates();
  renderPalette();
  initCanvasInteractions();
  await loadDashboards();
  const m = location.hash.match(/^#\/d\/(.+)$/);
  await seedTopics();
  await openDashboard(m ? m[1] : prefs.get('lastDash', null));
  connect();
  setInterval(seedTopics, 60000);
})();
