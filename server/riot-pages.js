'use strict';
// Builds dashboards for RIOT controllers from their self-description (info) and the model profile labels.
// Well page: header (name, online, last data) then sections of cards; Riots overview: one tile per controller.

const OVERVIEW_ID = 'riots';
const pageId = (id) => 'riot-' + id.toLowerCase();
const WIDTH = 1380;
const COLORS = ['#38bdf8', '#f97316', '#a3e635', '#f472b6', '#a78bfa', '#fbbf24'];

function grouper(tags) {
  const g = { pressure: [], analogIn: [], flow: [], outputsA: [], outputsD: [], inputsD: [], calc: [], other: [] };
  for (const t of tags) {
    const src = String(t.source || '').toLowerCase();
    if (/flow/.test(src) || /^FLOW\d/.test(t.name)) g.flow.push(t);
    else if (/calc|manual/.test(src)) g.calc.push(t);
    else if (t.type === 'digital') (t.writable ? g.outputsD : g.inputsD).push(t);
    else if (t.writable) g.outputsA.push(t);
    else if (/kpa|psi|bar|mpa/i.test(t.units || '')) g.pressure.push(t);
    else if (t.type === 'analog') g.analogIn.push(t);
    else g.other.push(t);
  }
  return g;
}

// Lays cards left-to-right, wrapping at the page width, one section after another.
class Layout {
  constructor() { this.y = 10; this.widgets = []; this.n = 0; this.order = 0; }
  add(type, x, y, w, h, props) {
    const wd = { id: 'g' + (++this.n), type, x, y, w, h, props: { frame: true, label: '', ...props } };
    if (!wd.props.mobileHide) wd.props.mobileOrder = ++this.order;
    this.widgets.push(wd);
    return wd;
  }
  section(title, cards, note) {
    if (!cards.length) return;
    this.add('label', 20, this.y, 900, 32, { text: title, fontSize: 17, bold: true, frame: false });
    let y = this.y + 36;
    if (note) { this.add('label', 20, y, 900, 20, { text: note, fontSize: 12, bold: false, color: '#8492a6', frame: false, mobileHide: true }); y += 24; }
    let x = 20, rowH = 0;
    for (const c of cards) {
      if (x + c.w > WIDTH && x > 20) { x = 20; y += rowH + 12; rowH = 0; }
      this.add(c.type, x, y, c.w, c.h, c.props);
      x += c.w + 12; rowH = Math.max(rowH, c.h);
    }
    this.y = y + rowH + 24;
  }
}

function wellPage(d, { prefix, labelFor }) {
  const base = `${prefix}/${d.id}`;
  const tags = d.info.tags || [];
  const topic = (t) => `${base}/tag/${t.name}`;
  const g = grouper(tags);
  const L = new Layout();

  // Header
  L.add('label', 20, 10, 520, 46, { text: d.name || d.id, fontSize: 26, bold: true, frame: false });
  L.add('status', 550, 10, 300, 58, { label: '', topic: `${base}/status/online`, states: 'true=Online:#22c55e\nfalse=Offline:#ef4444', frame: false });
  L.add('label', 870, 14, 490, 24, { text: '', topic: `${base}/meta/lastData`, template: 'Last data: {value}', fontSize: 13, bold: false, color: '#8492a6', frame: false });
  const site = d.info.site || {};
  L.add('label', 870, 38, 490, 22, { text: [d.model, site.location, `ID ${d.id}`].filter(Boolean).join(' · '), fontSize: 12, bold: false, color: '#8492a6', frame: false });
  L.y = 80;

  const gauge = (t) => {
    const r = Array.isArray(t.range) ? t.range : null;
    return r && r[1] > r[0]
      ? { type: 'gauge', w: 210, h: 195, props: { label: labelFor(t), topic: topic(t), units: t.units, min: r[0], max: r[1], decimals: r[1] >= 1000 ? 0 : 1, color: '#38bdf8' } }
      : value(t);
  };
  const value = (t, big) => ({ type: 'value', w: big ? 260 : 200, h: big ? 120 : 105, props: { label: labelFor(t), topic: topic(t), units: t.units, decimals: /HOUR|DAY/.test(t.name) ? 3 : 1, fontSize: big ? 36 : 28 } });
  const bar = (t) => ({ type: 'bar', w: 280, h: 82, props: { label: labelFor(t), topic: topic(t), units: t.units, min: t.range ? t.range[0] : 0, max: t.range ? t.range[1] : 100, decimals: 1, color: '#a78bfa' } });
  const lamp = (t, color) => ({ type: 'lamp', w: 150, h: 105, props: { label: labelFor(t), topic: topic(t), onColor: color, offColor: '#334155' } });

  L.section('Pressures', g.pressure.map(gauge));
  L.section('Measurements', g.analogIn.map(gauge));
  // Flow runs: rate first and bigger
  const flowCards = [...g.flow].sort((a, b) => (/RATE/.test(b.name) ? 1 : 0) - (/RATE/.test(a.name) ? 1 : 0)).map((t) => value(t, /RATE/.test(t.name)));
  L.section('Flow', flowCards);
  L.section('Outputs', [...g.outputsA.map(bar), ...g.outputsD.map((t) => lamp(t, '#f59e0b'))], 'Shown read-only: the controller does not accept commands over MQTT yet.');
  L.section('Discrete inputs', g.inputsD.map((t) => lamp(t, '#22c55e')));
  L.section('Calculated and manual values', g.calc.map((t) => value(t)));
  L.section('Other', g.other.map((t) => value(t)));

  // Trends (history comes from the broker)
  const trends = [];
  const series = (list) => list.slice(0, 6).map((t, i) => `${topic(t)}||${labelFor(t)}|${COLORS[i % COLORS.length]}`).join('\n');
  if (g.pressure.length) trends.push({ type: 'trend', w: 674, h: 270, props: { label: 'Pressure trend', series: series(g.pressure), window: 6 * 3600, units: g.pressure[0].units } });
  const flowRate = g.flow.filter((t) => /RATE/.test(t.name));
  const trend2 = flowRate.length ? flowRate : g.analogIn;
  if (trend2.length) trends.push({ type: 'trend', w: 674, h: 270, props: { label: flowRate.length ? 'Flow rate trend' : 'Measurements trend', series: series(trend2), window: 6 * 3600, units: trend2[0].units } });
  L.section('Trends (last 6 hours)', trends);

  return {
    name: d.name || d.id,
    settings: { grid: 10, width: WIDTH + 20, height: Math.max(L.y + 20, 700), background: '', generated: { by: 'riot', controller: d.id, model: d.model, at: Date.now() } },
    widgets: L.widgets,
  };
}

// Picks the most telling values for a tile: flow rate, then pressures, then anything analog.
function keyTags(d) {
  const tags = (d.info && d.info.tags) || [];
  const g = grouper(tags);
  return [...g.flow.filter((t) => /RATE/.test(t.name)), ...g.pressure, ...g.analogIn].slice(0, 2);
}

function overviewPage(devices, { prefix, labelFor }) {
  const widgets = []; let n = 0, order = 0;
  const add = (type, x, y, w, h, props) => { const wd = { id: 'o' + (++n), type, x, y, w, h, props: { frame: false, label: '', ...props } }; if (!wd.props.mobileHide) wd.props.mobileOrder = ++order; widgets.push(wd); };
  add('label', 20, 10, 700, 44, { text: 'Riots', fontSize: 26, bold: true });
  add('label', 20, 52, 900, 22, { text: devices.length ? 'Tap a controller to open its page.' : 'No approved controllers yet. Approve one on the Riots page.', fontSize: 13, bold: false, color: '#8492a6' });
  const TW = 330, TH = 250, COLS = 4;
  devices.forEach((d, i) => {
    const base = `${prefix}/${d.id}`;
    const x = 20 + (i % COLS) * (TW + 14), y = 90 + Math.floor(i / COLS) * (TH + 14);
    add('label', x, y, TW, TH, { text: '', frame: true, link: pageId(d.id) });   // tile backdrop (hidden in list view)
    add('label', x + 14, y + 10, TW - 28, 34, { text: d.name || d.id, fontSize: 19, bold: true, link: pageId(d.id) });
    add('status', x + 8, y + 46, 140, 50, { topic: `${base}/status/online`, states: 'true=Online:#22c55e\nfalse=Offline:#ef4444' });
    add('label', x + 160, y + 58, TW - 170, 22, { text: `${d.model || ''} · ${d.id}`, fontSize: 11, bold: false, color: '#8492a6' });
    keyTags(d).forEach((t, k) => add('value', x + 10 + k * ((TW - 30) / 2 + 10), y + 104, (TW - 30) / 2, 96, { label: labelFor(d, t), topic: `${base}/tag/${t.name}`, units: t.units, decimals: 1, fontSize: 24, frame: true, link: pageId(d.id) }));
    add('label', x + 14, y + TH - 36, TW - 28, 24, { text: 'Open →', fontSize: 13, bold: true, color: '#38bdf8', link: pageId(d.id), align: 'right' });
  });
  return { name: 'Riots', settings: { grid: 10, width: 1420, height: Math.max(400, 110 + Math.ceil(devices.length / COLS) * (TH + 14)), generated: { by: 'riot', overview: true, at: Date.now() } }, widgets };
}

module.exports = { wellPage, overviewPage, pageId, OVERVIEW_ID, grouper };
