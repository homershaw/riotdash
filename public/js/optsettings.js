// Optimizer settings dialog: shows the R/W soft points of one optimizer run and writes changes through
// riotdash (POST /api/riots/<id>/opt/set), which waits for the controller's ack.
import { h } from './widgets.js';

const MODES = ['Invalid', 'Time On vs. Time Off', 'Critical Flow vs. Time Off', 'Critical Flow vs. CSD < SP', 'Critical Flow vs. CSD > SP',
  'CSD < SP vs. Time Off', 'Critical Flow vs. Casing > SP', 'Critical Flow vs. Load Factor', 'Self Optimization Plunger'];
// Points shown as a choice instead of a number box
const CHOICES = {
  'SPT0.2': [[0, 'Off (calculated)'], [1, 'On (manual setpoint)']],
  'SPT0.3': [[0, 'Flow select'], [1, 'Off'], [2, 'On']],
  'SPT0.5': [[0, 'Off'], [1, 'On']],
  'SPT0.7': MODES.slice(1).map((n, i) => [i + 1, `${i + 1} · ${n}`]),
};
const GROUPS = [['SPT0', 'Main setup'], ['SPT1', 'Setpoints'], ['SPT2', 'Tuning limits']];
const START_STOP = 'SPT0.6';

const fmt = (k, v) => {
  if (v === null || v === undefined || v === '') return '—';
  const c = CHOICES[k] && CHOICES[k].find(([x]) => x === Number(v));
  if (c) return c[1];
  if (k === START_STOP) return Number(v) ? 'Running' : 'Stopped';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
};
const sortKey = (k) => { const [a, b] = k.slice(3).split('.').map(Number); return a * 1000 + b; };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export async function openOptSettings(id, run = 1) {
  const dlg = h('dialog', { class: 'opt-dlg' });
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const base = `/api/riots/${encodeURIComponent(id)}/opt`;
  let st = null;
  const edits = new Map();   // key -> new value (number)

  const status = h('div', { class: 'opt-status' });
  const body = h('div', { class: 'opt-body' }, 'Loading…');
  const applyBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => apply() }, 'Apply changes');
  dlg.append(h('div', { class: 'opt-wrap' },
    h('div', { class: 'opt-head' }, h('h2', {}, 'Optimizer settings'), h('span', { class: 'opt-sub' }), h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close(), title: 'Close' }, '✕')),
    status, body,
    h('div', { class: 'opt-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Close'), applyBtn)));
  dlg.showModal();

  function say(text, kind = '') { status.textContent = text; status.className = 'opt-status ' + kind; }
  function refreshApply() { applyBtn.disabled = !edits.size || !st.writable; applyBtn.textContent = edits.size ? `Apply ${edits.size} change${edits.size > 1 ? 's' : ''}` : 'Apply changes'; }

  async function load() {
    try { st = await api(`${base}?run=${run}`); } catch (e) { body.textContent = 'Could not load: ' + e.message; return; }
    dlg.querySelector('.opt-sub').textContent = `${st.name} · run ${run}${st.program ? ' · OPT ' + st.program : ''}${st.online === false ? ' · offline' : ''}`;
    if (!st.writable) say(st.writeBlock, 'warn');
    else say('Changes are sent to the controller, which checks them and replies. Writes must be turned on at the controller (its MQTT page).');
    render();
  }

  function input(k, p) {
    const cur = p.value, val = edits.has(k) ? edits.get(k) : cur;
    const set = (v) => {
      const n = v === '' ? NaN : Number(v);
      if (Number.isFinite(n) && n !== Number(cur)) edits.set(k, n); else edits.delete(k);
      row.classList.toggle('changed', edits.has(k)); refreshApply();
    };
    let ctl;
    if (CHOICES[k]) {
      ctl = h('select', { disabled: !st.writable, onchange: (e) => set(e.target.value) },
        ...CHOICES[k].map(([x, n]) => h('option', { value: x, selected: Number(val) === x }, n)),
        CHOICES[k].some(([x]) => x === Number(cur)) ? null : h('option', { value: '', selected: true, disabled: true }, fmt(k, cur)));
    } else {
      ctl = h('input', { type: 'number', step: 'any', value: val ?? '', disabled: !st.writable, oninput: (e) => set(e.target.value) });
    }
    const row = h('tr', { class: edits.has(k) ? 'changed' : '' },
      h('td', { class: 'mono' }, k), h('td', {}, p.name), h('td', { class: 'cur' }, fmt(k, cur)), h('td', {}, ctl), h('td', { class: 'u' }, p.units || ''));
    return row;
  }

  function render() {
    const pts = st.points || {};
    const rw = Object.keys(pts).filter((k) => Number(pts[k].rw) && k !== START_STOP && pts[k].value !== null).sort((a, b) => sortKey(a) - sortKey(b));
    const parts = [];
    // Start / stop: a button with its own confirmation
    if (pts[START_STOP] && Number(pts[START_STOP].rw)) {
      const running = Number(pts[START_STOP].value) === 1;
      parts.push(h('div', { class: 'opt-run' },
        h('span', {}, 'Optimizer program: ', h('b', { class: running ? 'ok' : 'bad' }, running ? 'Running' : 'Stopped')),
        h('button', { type: 'button', class: running ? 'btn danger' : 'btn primary', disabled: !st.writable,
          onclick: () => send({ [START_STOP]: running ? 0 : 1 }, `${running ? 'STOP' : 'START'} the optimizer on ${st.name}?${running ? '\n\nThe well will no longer be cycled by the optimizer.' : ''}`) },
        running ? 'Stop optimizer' : 'Start optimizer')));
    }
    for (const [g, title] of GROUPS) {
      const keys = rw.filter((k) => k.startsWith(g + '.'));
      if (!keys.length) continue;
      parts.push(h('h4', {}, title), h('table', { class: 'opt-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Point'), h('th', {}, 'Name'), h('th', {}, 'Current'), h('th', {}, 'New'), h('th', {}, ''))),
        h('tbody', {}, ...keys.map((k) => input(k, pts[k])))));
    }
    if (!rw.length) parts.push(h('div', { class: 'empty' }, 'No changeable points yet. They appear once the controller has sent its soft points.'));
    const w = st.writes || [];
    if (w.length) {
      parts.push(h('h4', {}, 'Recent changes'), h('table', { class: 'opt-table opt-log' }, h('tbody', {}, ...w.slice(0, 10).map((e) => h('tr', {},
        h('td', {}, when(e.at)), h('td', {}, e.by),
        h('td', {}, Object.entries(e.values).map(([k, v]) => `${(pts[k] && pts[k].name) || k}: ${fmt(k, e.before && e.before[k])} → ${fmt(k, v)}`).join(', ')),
        h('td', { class: e.ok ? 'ok' : 'bad' }, e.ok ? 'applied' : e.timeout ? 'no reply' : 'rejected', e.ok ? '' : h('small', {}, ' ' + e.error)))))));
    }
    body.replaceChildren(...parts);
    refreshApply();
  }

  function apply() {
    const pts = st.points;
    const lines = [...edits].map(([k, v]) => `• ${pts[k] ? pts[k].name : k}: ${fmt(k, pts[k] && pts[k].value)} → ${fmt(k, v)}${pts[k] && pts[k].units ? ' ' + pts[k].units : ''}`);
    send(Object.fromEntries(edits), `Send these changes to ${st.name}?\n\n${lines.join('\n')}`);
  }

  async function send(values, question) {
    if (!confirm(question)) return;
    say('Sending… waiting for the controller to reply.', '');
    applyBtn.disabled = true;
    try {
      const r = await api(`${base}/set`, { run, values });
      if (r.ok) { say('✔ Applied by the controller.', 'ok'); edits.clear(); }
      else say(`✘ Not applied: ${r.error || 'rejected'}`, 'bad');
    } catch (e) { say('✘ ' + e.message, 'bad'); }
    // The controller re-sends its soft points after a write: give them a moment, then reload.
    setTimeout(async () => { const keep = status.textContent, kind = status.className; await load(); status.textContent = keep; status.className = kind; }, 1200);
  }

  load();
}
