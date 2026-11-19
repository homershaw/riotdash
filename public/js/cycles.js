// Cycles page: plunger cycle history per well (server/cycles.js) and CSV import.
import { h } from './widgets.js';

const $ = (s) => document.querySelector(s);
try { document.documentElement.dataset.theme = JSON.parse(localStorage.getItem('mqttdash.theme') || '"dark"'); } catch { /* default */ }
function toast(msg, kind = '') { const t = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(t); setTimeout(() => t.classList.add('out'), 2600); setTimeout(() => t.remove(), 3000); }
const api = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const tz = -new Date().getTimezoneOffset();
const f = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const time = (t) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const MSC = { 2001: 'Time on', 2002: 'Time on bypass', 2003: 'Time off', 2004: 'Time off bypass', 2005: 'Pre-flow on', 2006: 'Pre-flow off', 2007: 'Critical flow bypass', 2008: 'Casing static DP bypass',
  2009: 'Stable flow', 2010: 'Line pressure high', 2011: 'Plunger rising', 2012: 'Post plunger sales', 2013: 'Casing bypass', 2014: 'Backup time off', 2015: 'Load factor bypass', 2016: 'Extended shut-in' };
const ARR = [['ontime', 'On time', 'var(--ok)'], ['early', 'Early', '#a78bfa'], ['late', 'Late', '#f97316'], ['failed', 'Failed', 'var(--alarm)']];

const SEV = { alarm: ['Alarm', '⛔'], warn: ['Warning', '⚠'], info: ['Note', 'ℹ'], ok: ['OK', '✓'] };
let wells = [], current, highlight = new Set(), lastData = null; current = new URLSearchParams(location.search).get('well') || null;

async function loadWells() {
  try { wells = await api('/api/cycles'); } catch (e) { toast('Could not load: ' + e.message, 'error'); return; }
  $('#wells').replaceChildren(...(wells.length ? wells.map((w) => h('button', { type: 'button', class: 'cy-well' + (w.well === current ? ' active' : ''), onclick: () => pick(w.well) },
    h('b', {}, h('i', { class: 'adv-dot ' + (w.advisor || 'ok'), title: (SEV[w.advisor] || SEV.ok)[0] }), w.well), h('span', {}, `${f(w.cycles)} cycles · last ${time(w.last)}`))) : [h('div', { class: 'empty' }, 'No cycles yet.')]));
  $('#demoDel').hidden = !wells.some((w) => /^DEMO /.test(w.well));
  if (!current && wells.length) pick(wells[0].well); else if (current) load();
}

function pick(well) {
  if (well !== current) $('#until').value = '';   // each well opens at its own latest data
  current = well;
  history.replaceState(null, '', '?well=' + encodeURIComponent(well));
  document.querySelectorAll('.cy-well').forEach((b) => b.classList.toggle('active', b.querySelector('b').textContent === well));
  highlight = new Set();
  load();
}

async function load() {
  if (!current) return;
  let d;
  // ending date: the end of the chosen day (local), or let the server pick (now, or the well's last cycle)
  const u = $('#until').value ? Math.floor(new Date($('#until').value + 'T23:59:59').getTime() / 1000) : '';
  try { d = await api(`/api/cycles/${encodeURIComponent(current)}?days=${$('#days').value}&tz=${tz}&limit=200${u ? '&until=' + u : ''}`); } catch (e) { toast(e.message, 'error'); return; }
  const ymd = (t) => { const x = new Date(t * 1000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  if (d.until) $('#until').value = ymd(d.until - 1);
  if (d.first && d.last) { $('#until').min = ymd(d.first); $('#until').max = ymd(Math.max(d.last, Date.now() / 1000)); }
  const ended = d.last && Date.now() / 1000 - d.last > 86400;
  $('#range').hidden = !d.first;
  $('#range').textContent = d.first ? `Data from ${new Date(d.first * 1000).toLocaleDateString()} to ${new Date(d.last * 1000).toLocaleDateString()}${ended ? ' (history, no recent cycles)' : ''}. Pick an ending date to look further back.` : '';
  $('#wellName').textContent = current;
  lastData = d;
  $('#demoNote').hidden = !d.demo; $('#demoNote').textContent = d.demo ? `Demo well (simulated data): ${d.demo}` : '';
  renderAdvisor(d.advisor);
  $('#empty').hidden = !!d.total; $('#content').hidden = !d.total;
  if (!d.total) { $('#empty').textContent = `No cycles in the ${$('#days').selectedOptions[0].textContent} ending ${$('#until').value}.`; return; }
  const days = d.daily, n = days.length || 1, sum = (k) => days.reduce((a, x) => a + (x[k] || 0), 0);
  const arrived = sum('ontime') + sum('early') + sum('late'), judged = arrived + sum('failed');
  const gasDays = days.filter((x) => x.gas !== null);
  const vel = days.filter((x) => x.avgVelocity).map((x) => x.avgVelocity);
  $('#tiles').replaceChildren(
    tile('Cycles per day', f(sum('cycles') / n, 1)),
    tile('Gas per day', gasDays.length ? f(gasDays.reduce((a, x) => a + x.gas, 0) / gasDays.length, 2) : '—', 'E3m3'),
    tile('On-time arrivals', judged ? f(sum('ontime') / judged * 100, 0) : '—', '%'),
    tile('Failed arrivals', judged ? f(sum('failed') / judged * 100, 0) : '—', '%'),
    tile('Average velocity', vel.length ? f(vel.reduce((a, b) => a + b, 0) / vel.length, 0) : '—', 'm/min'));
  const asc = [...days].reverse();
  barChart($('#gasChart'), asc.map((x) => ({ label: x.day, parts: [{ v: x.gas || 0, color: 'var(--accent)', name: 'Gas', fmt: f(x.gas, 2) + ' E3m3' }] })));
  barChart($('#arrChart'), asc.map((x) => ({ label: x.day, parts: ARR.map(([k, name, color]) => ({ v: x[k], color, name, fmt: f(x[k]) })).concat(x.none ? [{ v: x.none, color: 'var(--muted)', name: 'No sensor', fmt: f(x.none) }] : []) })));
  $('#arrLegend').replaceChildren(...ARR.map(([, name, color]) => h('span', {}, h('i', { style: { background: color } }), name)));
  $('#daily').replaceChildren(...days.map((x) => h('tr', {}, h('td', {}, x.day), h('td', {}, f(x.cycles)), h('td', {}, f(x.gas, 2)), h('td', {}, f(x.avgShutInMin, 1)), h('td', {}, f(x.avgFlowMin, 1)),
    h('td', {}, f(x.avgVelocity)), h('td', {}, f(x.ontime)), h('td', {}, f(x.early)), h('td', { class: x.late ? 'warn' : '' }, f(x.late)), h('td', { class: x.failed ? 'bad' : '' }, f(x.failed)), h('td', {}, f(x.lineHighCycles)))));
  $('#totalNote').textContent = d.total > d.cycles.length ? `(newest ${d.cycles.length} of ${f(d.total)})` : '';
  renderRecent();
}

function renderRecent() {
  const d = lastData;
  $('#recent').replaceChildren(...d.cycles.map((c) => h('tr', { class: highlight.has(c.openTs) ? 'hl' : '' },
    h('td', {}, time(c.openTs)), h('td', {}, f(c.shutInMin, 1)), h('td', {}, f(c.tripMin, 1)),
    h('td', { class: c.arrival === 'failed' ? 'bad' : c.arrival === 'late' || c.arrival === 'early' ? 'warn' : '' }, (ARR.find(([k]) => k === c.arrival) || [, c.arrival === 'none' ? 'No sensor' : c.arrival])[1]),
    h('td', {}, f(c.velocity)), h('td', {}, f(c.afterflowMin, 1)), h('td', {}, f(c.flowMin, 1)),
    h('td', {}, `${f(c.casingOpen)} / ${f(c.tubingOpen)} / ${f(c.lineOpen)}`), h('td', {}, f(c.gas, 2)), h('td', {}, c.mode ?? '—'),
    h('td', {}, typeof c.end === 'number' ? (MSC[c.end] || c.end) : (c.end || '—')))));
}

function renderAdvisor(a) {
  $('#advAsOf').textContent = a && a.asOf ? `as of ${time(a.asOf)} · recent cycles against the two weeks before` : '';
  if (!a || !a.findings.length) {
    $('#advisor').replaceChildren(h('div', { class: 'adv-ok' }, h('span', {}, '✓'), a && a.recentCycles ? `Nothing unusual: ${a.recentCycles} cycles in the last 48 h look like the 14 days before.` : 'Not enough recent cycles to judge.'));
    return;
  }
  $('#advisor').replaceChildren(...a.findings.map((x) => {
    const [label, icon] = SEV[x.severity] || SEV.info;
    const card = h('div', { class: 'adv-card ' + x.severity },
      h('div', { class: 'adv-title' }, h('span', { class: 'adv-sev' }, icon, ' ', label), h('b', {}, x.title)),
      h('p', {}, x.detail),
      h('p', {}, h('em', {}, 'Likely cause: '), x.cause),
      h('p', {}, h('em', {}, 'Consider: '), x.action),
      x.cycles && x.cycles.length ? h('button', { type: 'button', class: 'btn adv-show', onclick: () => {
        const on = !(highlight.size && x.cycles.every((t) => highlight.has(t)));
        highlight = on ? new Set(x.cycles) : new Set();
        renderRecent();
        if (on) $('#recent tr.hl')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } }, `Show the ${x.cycles.length} cycles behind this`) : null);
    return card;
  }));
}

const tile = (label, value, units = '') => h('div', { class: 'cy-tile' }, h('span', {}, label), h('b', {}, value, units ? h('small', {}, ' ' + units) : ''));

// Vertical bars, stacked when a day has several parts. Hovering a day shows its values.
function barChart(el, data) {
  const W = 560, H = 190, L = 34, B = 22, T = 8, gap = 2;
  const max = Math.max(1e-9, ...data.map((d) => d.parts.reduce((a, p) => a + (p.v || 0), 0)));
  const step = niceStep(max / 4), top = Math.ceil(max / step) * step || 1;
  const bw = (W - L - 4) / Math.max(1, data.length), y = (v) => T + (H - T - B) * (1 - v / top);
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'cy-svg');
  const add = (tag, a, parent = svg) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); parent.append(e); return e; };
  for (let v = 0; v <= top + 1e-9; v += step) {
    add('line', { x1: L, x2: W, y1: y(v), y2: y(v), class: 'cy-grid' });
    add('text', { x: L - 5, y: y(v) + 3.5, class: 'cy-ax', 'text-anchor': 'end' }).textContent = step < 1 ? v.toFixed(1) : Math.round(v);
  }
  const every = Math.ceil(data.length / 7);
  data.forEach((d, i) => {
    const x = L + 2 + i * bw, w = Math.max(1, Math.min(28, bw - 3)), cx = x + (bw - w) / 2;
    let acc = 0;
    const parts = d.parts.filter((p) => p.v > 0);
    parts.forEach((p, k) => {
      const y1 = y(acc + p.v), y0 = y(acc); acc += p.v;
      const hgt = Math.max(0, y0 - y1 - (k < parts.length - 1 ? gap : 0));
      const r = k === parts.length - 1 ? Math.min(3, w / 2, hgt) : 0;
      add('path', { d: `M${cx},${y0 - (k ? 0 : 0)} V${y1 + r} Q${cx},${y1} ${cx + r},${y1} H${cx + w - r} Q${cx + w},${y1} ${cx + w},${y1 + r} V${y0} Z`, fill: p.color, class: 'cy-bar' });
    });
    if (i % every === 0) add('text', { x: x + bw / 2, y: H - 6, class: 'cy-ax', 'text-anchor': 'middle' }).textContent = d.label.slice(5);
    const hit = add('rect', { x, y: T, width: bw, height: H - T - B, class: 'cy-hit' });
    add('title', {}, hit).textContent = `${d.label}\n` + d.parts.map((p) => `${p.name}: ${p.fmt}`).join('\n');
  });
  el.replaceChildren(svg);
}
function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x || 1)), m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

// Import
$('#importBtn').addEventListener('click', () => { $('#impResult').textContent = ''; $('#importDlg').showModal(); });
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#impGo').addEventListener('click', async () => {
  const file = $('#impFile').files[0];
  if (!file) { $('#impResult').textContent = 'Choose a CSV file first.'; return; }
  $('#impGo').disabled = true; $('#impResult').textContent = 'Importing…';
  try {
    const well = $('#impWell').value.trim();
    const r = await api('/api/cycles/import' + (well ? '?well=' + encodeURIComponent(well) : ''), { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
    const lines = Object.entries(r.wells).map(([w, x]) => `${w}: ${x.added} added${x.duplicates ? `, ${x.duplicates} already there` : ''}`);
    if (r.errorCount) lines.push(`${r.errorCount} row(s) skipped: ` + r.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.error}`).join('; '));
    $('#impResult').replaceChildren(h('b', {}, `${r.rows} rows read.`), ...lines.map((l) => h('div', {}, l)));
    const first = Object.keys(r.wells)[0];
    if (first) current = first;
    loadWells();
  } catch (e) { $('#impResult').textContent = 'Import failed: ' + e.message; }
  $('#impGo').disabled = false;
});
$('#days').addEventListener('change', load);
$('#until').addEventListener('change', load);
$('#demoAdd').addEventListener('click', async () => {
  if (!confirm('Add six demo wells with 30 days of simulated cycles? Each has a known problem for the Advisor to find. They are named "DEMO …" and can be removed again.')) return;
  try { await api('/api/cycles/demo', { method: 'POST' }); current = 'DEMO Healthy'; toast('Demo wells added'); loadWells(); } catch (e) { toast(e.message, 'error'); }
});
$('#demoDel').addEventListener('click', async () => {
  if (!confirm('Remove all DEMO wells and their simulated cycles? Real wells are not touched.')) return;
  try { const r = await api('/api/cycles/demo', { method: 'DELETE' }); if (/^DEMO /.test(current || '')) { current = null; history.replaceState(null, '', '/cycles'); $('#content').hidden = true; $('#empty').hidden = false; } toast(`Removed ${r.removed.length} demo wells`); loadWells(); } catch (e) { toast(e.message, 'error'); }
});
loadWells();
