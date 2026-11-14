// Widget library. Each widget type declares: label, icon, size, defaults, fields (property schema),
// optional topics(props) and create(el, props, api) -> { onMessage(topic, payload), destroy() }.

import { topicMatches } from './mqtt.js';

// ---------- helpers ----------
const SVGNS = 'http://www.w3.org/2000/svg';
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}
export function extract(raw, path) {
  if (!path) return raw;
  let obj;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  for (const key of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (obj === null || obj === undefined) return undefined;
    obj = obj[key];
  }
  return typeof obj === 'object' && obj !== null ? JSON.stringify(obj) : obj;
}
const num = (v) => (v === '' || v === null || v === undefined || typeof v === 'boolean' ? NaN : Number(v));
const fmt = (v, d) => {
  const n = num(v);
  if (Number.isNaN(n)) return v === undefined ? '—' : String(v);
  return d === '' || d === undefined || d === null ? String(+n.toFixed(3)) : n.toFixed(Number(d));
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ON_WORDS = ['1', 'true', 'on', 'open', 'opened', 'run', 'running', 'start', 'started', 'yes', 'active', 'high'];
export function isOn(value, onValue) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (onValue !== undefined && onValue !== '') return v.toLowerCase() === String(onValue).toLowerCase();
  if (!Number.isNaN(num(v))) return num(v) > 0;
  return ON_WORDS.includes(v.toLowerCase());
}
function levelColor(n, p, base) {
  if (Number.isNaN(n)) return base;
  if (p.alarmHigh !== '' && p.alarmHigh !== undefined && n >= num(p.alarmHigh)) return 'var(--alarm)';
  if (p.alarmLow !== '' && p.alarmLow !== undefined && n <= num(p.alarmLow)) return 'var(--alarm)';
  if (p.warnHigh !== '' && p.warnHigh !== undefined && n >= num(p.warnHigh)) return 'var(--warn)';
  if (p.warnLow !== '' && p.warnLow !== undefined && n <= num(p.warnLow)) return 'var(--warn)';
  return base;
}
function confirmed(p, api, msg) { return !p.confirm || api.confirm(msg); }

// Shared field groups
const F = {
  topic: { key: 'topic', label: 'State topic', type: 'topic' },
  jsonPath: { key: 'jsonPath', label: 'JSON path', type: 'text', hint: 'e.g. temp or data.values[0] — blank = raw payload' },
  command: { key: 'commandTopic', label: 'Command topic', type: 'topic', hint: 'blank = same as state topic' },
  units: { key: 'units', label: 'Units', type: 'text' },
  decimals: { key: 'decimals', label: 'Decimals', type: 'number' },
  min: { key: 'min', label: 'Min', type: 'number' },
  max: { key: 'max', label: 'Max', type: 'number' },
  thresholds: [
    { key: 'warnHigh', label: 'Warn ≥', type: 'number' }, { key: 'alarmHigh', label: 'Alarm ≥', type: 'number' },
    { key: 'warnLow', label: 'Warn ≤', type: 'number' }, { key: 'alarmLow', label: 'Alarm ≤', type: 'number' },
  ],
  retain: { key: 'retain', label: 'Publish retained', type: 'checkbox' },
  confirm: { key: 'confirm', label: 'Ask before sending', type: 'checkbox' },
};
const cmdTopic = (p) => p.commandTopic || p.topic;

// ---------- icons for palette ----------
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  value: I('<text x="3" y="17" font-size="12" fill="currentColor" stroke="none" font-weight="700">42</text>'),
  gauge: I('<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>'),
  tank: I('<rect x="6" y="3" width="12" height="18" rx="3"/><path d="M6 13h12"/>'),
  bar: I('<rect x="3" y="9" width="18" height="6" rx="1"/><rect x="3" y="9" width="11" height="6" fill="currentColor"/>'),
  trend: I('<path d="M3 17l5-6 4 3 6-8 3 3"/><path d="M3 21h18"/>'),
  switch: I('<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="16" cy="12" r="2.5" fill="currentColor"/>'),
  button: I('<rect x="4" y="7" width="16" height="10" rx="3"/><path d="M9 12h6"/>'),
  slider: I('<path d="M3 12h18"/><circle cx="9" cy="12" r="3" fill="currentColor"/>'),
  input: I('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 10v4"/>'),
  valve: I('<path d="M3 8v8l9-4zM21 8v8l-9-4z"/><path d="M12 12V5M9 5h6"/>'),
  pump: I('<circle cx="11" cy="13" r="6"/><path d="M11 7h9v4h-4"/><path d="M8 13h6"/>'),
  lamp: I('<circle cx="12" cy="12" r="6" fill="currentColor"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>'),
  pipe: I('<path d="M3 9h11a3 3 0 0 1 3 3v9M3 15h11"/>'),
  status: I('<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="7.5" cy="12" r="1.5" fill="currentColor"/>'),
  label: I('<path d="M5 6h14M12 6v13"/>'),
  log: I('<path d="M5 6h14M5 10h14M5 14h10M5 18h12"/>'),
  image: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>'),
};

// ---------- widget definitions ----------
export const WIDGETS = {
  value: {
    label: 'Value', group: 'Display', size: [180, 110],
    defaults: { topic: '', jsonPath: '', units: '', decimals: 1, fontSize: 36, warnHigh: '', alarmHigh: '', warnLow: '', alarmLow: '' },
    fields: [F.topic, F.jsonPath, F.units, F.decimals, { key: 'fontSize', label: 'Font size', type: 'number' }, ...F.thresholds],
    create(el, p) {
      const v = h('span', { class: 'v-num' }, '—');
      el.append(h('div', { class: 'v-wrap' }, v, h('span', { class: 'v-units' }, p.units)));
      v.style.fontSize = (p.fontSize || 36) + 'px';
      return { onMessage(_t, raw) {
        const x = extract(raw, p.jsonPath);
        v.textContent = fmt(x, p.decimals);
        v.style.color = levelColor(num(x), p, 'var(--text)');
      } };
    },
  },

  gauge: {
    label: 'Gauge', group: 'Display', size: [200, 190],
    defaults: { topic: '', jsonPath: '', units: '', min: 0, max: 100, decimals: 1, color: '#38bdf8', warnHigh: '', alarmHigh: '', warnLow: '', alarmLow: '' },
    fields: [F.topic, F.jsonPath, F.units, F.min, F.max, F.decimals, { key: 'color', label: 'Colour', type: 'color' }, ...F.thresholds],
    create(el, p) {
      const cx = 100, cy = 100, r = 78, A0 = 135, SW = 270;
      const pt = (a, rr = r) => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)];
      const arc = (a0, a1, rr = r) => {
        const [x0, y0] = pt(a0, rr), [x1, y1] = pt(a1, rr);
        return `M${x0} ${y0} A${rr} ${rr} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
      };
      const min = num(p.min) || 0, max = Number.isNaN(num(p.max)) ? 100 : num(p.max);
      const ang = (val) => A0 + SW * clamp01((val - min) / (max - min || 1));
      const svg = s('svg', { viewBox: '0 0 200 186', class: 'gauge' });
      svg.append(s('path', { d: arc(A0, A0 + SW), class: 'g-track' }));
      const band = (from, to, cls) => { if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) svg.append(s('path', { d: arc(ang(from), ang(to), r + 11), class: cls })); };
      band(num(p.warnHigh), Number.isNaN(num(p.alarmHigh)) ? max : num(p.alarmHigh), 'g-band warn');
      band(num(p.alarmHigh), max, 'g-band alarm');
      band(Number.isNaN(num(p.alarmLow)) ? min : num(p.alarmLow), num(p.warnLow), 'g-band warn');
      band(min, num(p.alarmLow), 'g-band alarm');
      const val = s('path', { d: arc(A0, A0 + 0.01), class: 'g-val', stroke: p.color });
      const needle = s('line', { x1: cx, y1: cy, x2: cx, y2: cy, class: 'g-needle', opacity: 0 });
      const txt = s('text', { x: cx, y: cy + 8, class: 'g-text' }); txt.textContent = '—';
      const u = s('text', { x: cx, y: cy + 30, class: 'g-units' }); u.textContent = p.units || '';
      const [mx, my] = pt(A0, r), [Mx, My] = pt(A0 + SW, r);
      const tmin = s('text', { x: mx + 4, y: my + 22, class: 'g-lim' }); tmin.textContent = min;
      const tmax = s('text', { x: Mx - 4, y: My + 22, class: 'g-lim' }); tmax.textContent = max;
      svg.append(val, needle, txt, u, tmin, tmax);
      el.append(svg);
      return { onMessage(_t, raw) {
        const x = num(extract(raw, p.jsonPath));
        if (Number.isNaN(x)) { txt.textContent = '—'; return; }
        const a = ang(x);
        val.setAttribute('d', arc(A0, Math.max(A0 + 0.01, a)));
        val.setAttribute('stroke', levelColor(x, p, p.color));
        const [x1, y1] = pt(a, r - 12), [x2, y2] = pt(a, r + 12);
        needle.setAttribute('x1', x1); needle.setAttribute('y1', y1); needle.setAttribute('x2', x2); needle.setAttribute('y2', y2);
        needle.setAttribute('opacity', 1);
        txt.textContent = fmt(x, p.decimals);
      } };
    },
  },

  tank: {
    label: 'Tank', group: 'Process', size: [130, 210], frame: false,
    defaults: { topic: '', jsonPath: '', units: '%', min: 0, max: 100, decimals: 0, color: '#38bdf8', warnHigh: '', alarmHigh: '', warnLow: '', alarmLow: '' },
    fields: [F.topic, F.jsonPath, F.units, F.min, F.max, F.decimals, { key: 'color', label: 'Liquid colour', type: 'color' }, ...F.thresholds],
    create(el, p) {
      const fill = h('div', { class: 'tank-fill', style: { background: p.color } });
      const txt = h('div', { class: 'tank-text' }, '—');
      const ticks = h('div', { class: 'tank-ticks' }, ...[0, 1, 2, 3, 4].map(() => h('i')));
      el.append(h('div', { class: 'tank' }, fill, ticks, txt));
      const min = num(p.min) || 0, max = Number.isNaN(num(p.max)) ? 100 : num(p.max);
      return { onMessage(_t, raw) {
        const x = num(extract(raw, p.jsonPath));
        if (Number.isNaN(x)) return;
        fill.style.height = clamp01((x - min) / (max - min || 1)) * 100 + '%';
        fill.style.background = levelColor(x, p, p.color);
        txt.textContent = `${fmt(x, p.decimals)} ${p.units || ''}`;
      } };
    },
  },

  bar: {
    label: 'Bar', group: 'Display', size: [240, 80],
    defaults: { topic: '', jsonPath: '', units: '', min: 0, max: 100, decimals: 1, orientation: 'horizontal', color: '#a78bfa', warnHigh: '', alarmHigh: '', warnLow: '', alarmLow: '' },
    fields: [F.topic, F.jsonPath, F.units, F.min, F.max, F.decimals,
      { key: 'orientation', label: 'Orientation', type: 'select', options: ['horizontal', 'vertical'] },
      { key: 'color', label: 'Colour', type: 'color' }, ...F.thresholds],
    create(el, p) {
      const vert = p.orientation === 'vertical';
      const fill = h('div', { class: 'bar-fill', style: { background: p.color } });
      const txt = h('div', { class: 'bar-text' }, '—');
      el.append(h('div', { class: 'bar ' + (vert ? 'vert' : 'horiz') }, h('div', { class: 'bar-track' }, fill), txt));
      const min = num(p.min) || 0, max = Number.isNaN(num(p.max)) ? 100 : num(p.max);
      return { onMessage(_t, raw) {
        const x = num(extract(raw, p.jsonPath));
        if (Number.isNaN(x)) return;
        const pct = clamp01((x - min) / (max - min || 1)) * 100 + '%';
        fill.style[vert ? 'height' : 'width'] = pct;
        fill.style.background = levelColor(x, p, p.color);
        txt.textContent = `${fmt(x, p.decimals)} ${p.units || ''}`;
      } };
    },
  },

  trend: {
    label: 'Trend', group: 'Display', size: [420, 240],
    defaults: { series: '', window: 300, min: '', max: '', units: '', decimals: 1 },
    fields: [
      { key: 'series', label: 'Series (one per line)', type: 'textarea', hint: 'topic|jsonPath|label|#colour — only topic is required. Drop topics here from the explorer.' },
      { key: 'window', label: 'Time window (s)', type: 'number' },
      { key: 'min', label: 'Y min (blank = auto)', type: 'number' }, { key: 'max', label: 'Y max (blank = auto)', type: 'number' },
      F.units, F.decimals,
    ],
    topics: (p) => parseSeries(p.series).map((x) => x.topic),
    create(el, p, api) {
      const series = parseSeries(p.series);
      const legend = h('div', { class: 'trend-legend' });
      const canvas = h('canvas');
      const wrap = h('div', { class: 'trend-canvas' }, canvas);
      el.append(legend, wrap);
      if (!series.length) { wrap.append(h('div', { class: 'empty-hint' }, 'Add topics in the Series property, or drop a topic here')); }
      const win = (num(p.window) || 300) * 1000;
      for (const sr of series) {
        sr.data = [];
        sr.valEl = h('b', {}, '—');
        legend.append(h('span', {}, h('i', { style: { background: sr.color } }), sr.label + ' ', sr.valEl));
        api.history(sr.topic).then((pts) => {
          const old = pts.map((x) => ({ t: x.t, v: num(extract(x.v, sr.path)) })).filter((x) => !Number.isNaN(x.v) && x.t > Date.now() - win);
          sr.data = old.concat(sr.data);
          schedule();
        });
      }
      let raf = 0;
      const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
      const ro = new ResizeObserver(schedule); ro.observe(wrap);
      const tick = setInterval(schedule, 1000);
      function draw() {
        const W = wrap.clientWidth, H = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
        if (!W || !H) return;
        canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        const g = canvas.getContext('2d'); g.scale(dpr, dpr);
        const css = getComputedStyle(document.documentElement);
        const grid = css.getPropertyValue('--grid').trim(), muted = css.getPropertyValue('--muted').trim();
        const L = 46, R = 8, T = 8, B = 20, now = Date.now(), t0 = now - win;
        let lo = Infinity, hi = -Infinity;
        for (const sr of series) {
          while (sr.data.length && sr.data[0].t < t0 - 5000) sr.data.shift();
          for (const d of sr.data) { if (d.v < lo) lo = d.v; if (d.v > hi) hi = d.v; }
        }
        if (!Number.isNaN(num(p.min))) lo = num(p.min);
        if (!Number.isNaN(num(p.max))) hi = num(p.max);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
        if (hi === lo) { hi += 1; lo -= 1; }
        if (Number.isNaN(num(p.min)) || Number.isNaN(num(p.max))) { const pad = (hi - lo) * 0.08; if (Number.isNaN(num(p.min))) lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad; if (Number.isNaN(num(p.max))) hi += pad; }
        const X = (t) => L + ((t - t0) / win) * (W - L - R);
        const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
        g.font = '11px ui-sans-serif, system-ui, sans-serif'; g.fillStyle = muted; g.strokeStyle = grid; g.lineWidth = 1;
        g.textAlign = 'right'; g.textBaseline = 'middle';
        for (let i = 0; i <= 4; i++) {
          const v = lo + ((hi - lo) * i) / 4, y = Math.round(Y(v)) + 0.5;
          g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
          g.fillText(fmt(v, Math.abs(hi - lo) < 10 ? 1 : 0), L - 6, y);
        }
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        const showSec = win < 3600e3 && W > 420;
        const nT = Math.max(1, Math.min(3, Math.floor((W - L - R) / (showSec ? 110 : 80))));
        for (let i = 0; i <= nT; i++) {
          const t = t0 + (win * i) / nT;
          g.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: showSec ? '2-digit' : undefined }), Math.min(Math.max(X(t), L + 28), W - R - 28), H - 5);
        }
        g.save(); g.beginPath(); g.rect(L, T, W - L - R, H - T - B); g.clip();
        for (const sr of series) {
          if (!sr.data.length) continue;
          g.strokeStyle = sr.color; g.lineWidth = 1.8; g.lineJoin = 'round'; g.beginPath();
          sr.data.forEach((d, i) => (i ? g.lineTo(X(d.t), Y(d.v)) : g.moveTo(X(d.t), Y(d.v))));
          const last = sr.data[sr.data.length - 1];
          g.lineTo(X(now), Y(last.v)); g.stroke();
        }
        g.restore();
      }
      return {
        onMessage(topic, raw) {
          for (const sr of series) {
            if (!topicMatches(sr.topic, topic)) continue;
            const v = num(extract(raw, sr.path));
            if (Number.isNaN(v)) continue;
            sr.data.push({ t: Date.now(), v });
            sr.valEl.textContent = `${fmt(v, p.decimals)}${p.units ? ' ' + p.units : ''}`;
          }
          schedule();
        },
        destroy() { ro.disconnect(); clearInterval(tick); cancelAnimationFrame(raf); },
      };
    },
  },

  switch: {
    label: 'Switch', group: 'Control', size: [170, 100],
    defaults: { topic: '', jsonPath: '', commandTopic: '', onPayload: 'ON', offPayload: 'OFF', retain: true, confirm: false, onColor: '#22c55e' },
    fields: [F.topic, F.jsonPath, F.command, { key: 'onPayload', label: 'ON payload', type: 'text' }, { key: 'offPayload', label: 'OFF payload', type: 'text' },
      { key: 'onColor', label: 'ON colour', type: 'color' }, F.retain, F.confirm],
    create(el, p, api) {
      let state = null;
      const sw = h('button', { class: 'toggle', type: 'button', 'aria-pressed': 'false' }, h('span', { class: 'knob' }));
      const lbl = h('span', { class: 'toggle-state' }, '—');
      sw.style.setProperty('--on', p.onColor);
      sw.addEventListener('click', () => {
        const next = !state;
        if (!confirmed(p, api, `Switch ${p.label || cmdTopic(p)} ${next ? 'ON' : 'OFF'}?`)) return;
        api.publish(cmdTopic(p), next ? p.onPayload : p.offPayload, { retain: !!p.retain });
        sw.classList.add('pending');
      });
      el.append(h('div', { class: 'toggle-wrap' }, sw, lbl));
      return { onMessage(_t, raw) {
        state = isOn(extract(raw, p.jsonPath), p.onPayload);
        sw.classList.remove('pending');
        sw.classList.toggle('on', !!state);
        sw.setAttribute('aria-pressed', String(!!state));
        lbl.textContent = state === null ? '—' : state ? 'ON' : 'OFF';
      } };
    },
  },

  button: {
    label: 'Button', group: 'Control', size: [160, 80],
    defaults: { commandTopic: '', payload: '1', text: 'Send', color: '#3b82f6', retain: false, confirm: false },
    fields: [{ key: 'commandTopic', label: 'Command topic', type: 'topic' }, { key: 'payload', label: 'Payload', type: 'text' },
      { key: 'text', label: 'Button text', type: 'text' }, { key: 'color', label: 'Colour', type: 'color' }, F.retain, F.confirm],
    topics: () => [],
    create(el, p, api) {
      const b = h('button', { class: 'btn-big', type: 'button', style: { background: p.color } }, p.text || 'Send');
      b.addEventListener('click', () => {
        if (!confirmed(p, api, `Send "${p.payload}" to ${p.commandTopic}?`)) return;
        api.publish(p.commandTopic, p.payload, { retain: !!p.retain });
        b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 250);
      });
      el.append(b);
      return {};
    },
  },

  slider: {
    label: 'Slider', group: 'Control', size: [260, 90],
    defaults: { topic: '', jsonPath: '', commandTopic: '', min: 0, max: 100, step: 1, units: '', retain: true },
    fields: [F.topic, F.jsonPath, F.command, F.min, F.max, { key: 'step', label: 'Step', type: 'number' }, F.units, F.retain],
    create(el, p, api) {
      const r = h('input', { type: 'range', min: p.min, max: p.max, step: p.step || 1, value: p.min });
      const out = h('span', { class: 'slider-val' }, '—');
      let dragging = false;
      r.addEventListener('input', () => { dragging = true; out.textContent = `${r.value} ${p.units || ''}`; });
      r.addEventListener('change', () => { dragging = false; api.publish(cmdTopic(p), r.value, { retain: !!p.retain }); });
      el.append(h('div', { class: 'slider-wrap' }, r, out));
      return { onMessage(_t, raw) {
        const x = num(extract(raw, p.jsonPath));
        if (Number.isNaN(x) || dragging) return;
        r.value = x; out.textContent = `${x} ${p.units || ''}`;
      } };
    },
  },

  input: {
    label: 'Text input', group: 'Control', size: [280, 90],
    defaults: { commandTopic: '', placeholder: 'Payload…', retain: false },
    fields: [{ key: 'commandTopic', label: 'Command topic', type: 'topic' }, { key: 'placeholder', label: 'Placeholder', type: 'text' }, F.retain],
    topics: () => [],
    create(el, p, api) {
      const i = h('input', { type: 'text', placeholder: p.placeholder });
      const send = () => { api.publish(p.commandTopic, i.value, { retain: !!p.retain }); i.select(); };
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      el.append(h('div', { class: 'input-wrap' }, i, h('button', { type: 'button', class: 'btn', onclick: send }, 'Send')));
      return {};
    },
  },

  valve: {
    label: 'Valve', group: 'Process', size: [110, 120], frame: false,
    defaults: { topic: '', jsonPath: '', commandTopic: '', openPayload: 'OPEN', closePayload: 'CLOSED', style: 'gate', orientation: 'horizontal',
      openColor: '#22c55e', closedColor: '#ef4444', clickable: true, confirm: true, retain: true },
    fields: [F.topic, F.jsonPath, F.command, { key: 'openPayload', label: 'Open payload', type: 'text' }, { key: 'closePayload', label: 'Close payload', type: 'text' },
      { key: 'style', label: 'Symbol', type: 'select', options: ['gate', 'control', 'ball', 'plain'] },
      { key: 'orientation', label: 'Orientation', type: 'select', options: ['horizontal', 'vertical'] },
      { key: 'openColor', label: 'Open colour', type: 'color' }, { key: 'closedColor', label: 'Closed colour', type: 'color' },
      { key: 'clickable', label: 'Click to operate', type: 'checkbox' }, F.confirm, F.retain],
    create(el, p, api) {
      const body = s('g', { class: 'v-body' },
        s('polygon', { points: '14,34 50,52 14,70' }), s('polygon', { points: '86,34 50,52 86,70' }));
      const g = s('g', { transform: p.orientation === 'vertical' ? 'rotate(90 50 52)' : '' },
        s('line', { x1: 0, y1: 52, x2: 14, y2: 52, class: 'v-pipe' }), s('line', { x1: 86, y1: 52, x2: 100, y2: 52, class: 'v-pipe' }), body);
      if (p.style === 'gate') g.append(s('line', { x1: 50, y1: 52, x2: 50, y2: 22, class: 'v-stem' }), s('line', { x1: 36, y1: 22, x2: 64, y2: 22, class: 'v-stem' }));
      if (p.style === 'control') g.append(s('line', { x1: 50, y1: 52, x2: 50, y2: 28, class: 'v-stem' }), s('path', { d: 'M32 28 A18 14 0 0 1 68 28 Z', class: 'v-act' }));
      if (p.style === 'ball') g.append(s('circle', { cx: 50, cy: 52, r: 8, class: 'v-ball' }), s('line', { x1: 50, y1: 44, x2: 50, y2: 26, class: 'v-stem' }), s('line', { x1: 50, y1: 26, x2: 68, y2: 26, class: 'v-stem' }));
      const svg = s('svg', { viewBox: '0 0 100 100', class: 'valve', preserveAspectRatio: 'xMidYMid meet' }, g);
      const st = h('div', { class: 'p-state' }, '—');
      el.append(svg, st);
      let state = null;
      if (p.clickable) {
        svg.classList.add('clickable');
        svg.addEventListener('click', () => {
          const next = !state;
          if (!confirmed(p, api, `${next ? 'OPEN' : 'CLOSE'} ${p.label || 'valve'}?`)) return;
          api.publish(cmdTopic(p), next ? p.openPayload : p.closePayload, { retain: !!p.retain });
        });
      }
      return { onMessage(_t, raw) {
        const x = extract(raw, p.jsonPath);
        const n = num(x);
        state = !Number.isNaN(n) && String(x).trim() !== '1' && String(x).trim() !== '0' ? n > 0 : isOn(x, p.openPayload);
        body.style.fill = state === null ? 'var(--muted)' : state ? p.openColor : p.closedColor;
        st.textContent = !Number.isNaN(n) && n > 1 ? `${fmt(n, 0)}%` : state === null ? String(x ?? '—') : state ? 'OPEN' : 'CLOSED';
      } };
    },
  },

  pump: {
    label: 'Pump / Fan', group: 'Process', size: [120, 130], frame: false,
    defaults: { topic: '', jsonPath: '', commandTopic: '', onPayload: 'ON', offPayload: 'OFF', faultPayload: 'FAULT', style: 'pump', flip: false,
      runColor: '#22c55e', stopColor: '#64748b', clickable: true, confirm: true, retain: true },
    fields: [F.topic, F.jsonPath, F.command, { key: 'onPayload', label: 'Run payload', type: 'text' }, { key: 'offPayload', label: 'Stop payload', type: 'text' },
      { key: 'faultPayload', label: 'Fault payload', type: 'text' },
      { key: 'style', label: 'Symbol', type: 'select', options: ['pump', 'fan', 'motor', 'blower'] },
      { key: 'flip', label: 'Mirror horizontally', type: 'checkbox' },
      { key: 'runColor', label: 'Running colour', type: 'color' }, { key: 'stopColor', label: 'Stopped colour', type: 'color' },
      { key: 'clickable', label: 'Click to start/stop', type: 'checkbox' }, F.confirm, F.retain],
    create(el, p, api) {
      const rotor = s('g', { class: 'rotor' });
      const g = s('g', { transform: p.flip ? 'translate(100 0) scale(-1 1)' : '' });
      if (p.style === 'motor') {
        g.append(s('rect', { x: 18, y: 28, width: 64, height: 44, rx: 6, class: 'p-body' }), s('rect', { x: 82, y: 44, width: 14, height: 12, class: 'p-body' }));
        const t = s('text', { x: 50, y: 58, class: 'p-motor-text' }); t.textContent = 'M'; g.append(t);
      } else {
        if (p.style === 'pump') g.append(s('path', { d: 'M50 20 H94 V36 H70', class: 'p-body' }), s('path', { d: 'M4 44 H22 V60 H4', class: 'p-body' }));
        if (p.style === 'blower') g.append(s('path', { d: 'M50 20 H94 V42 H76', class: 'p-body' }));
        g.append(s('circle', { cx: 50, cy: 52, r: 32, class: 'p-body' }));
        if (p.style === 'fan') {
          for (let i = 0; i < 4; i++) rotor.append(s('ellipse', { cx: 50, cy: 36, rx: 7, ry: 15, transform: `rotate(${i * 90} 50 52)`, class: 'p-blade' }));
        } else {
          for (let i = 0; i < 6; i++) rotor.append(s('path', { d: 'M50 52 Q58 40 52 26', transform: `rotate(${i * 60} 50 52)`, class: 'p-vane' }));
        }
        rotor.append(s('circle', { cx: 50, cy: 52, r: 5, class: 'p-hub' }));
        g.append(rotor);
      }
      const svg = s('svg', { viewBox: '0 0 100 100', class: 'pump' }, g);
      const st = h('div', { class: 'p-state' }, '—');
      el.append(svg, st);
      let state = null;
      if (p.clickable) {
        svg.classList.add('clickable');
        svg.addEventListener('click', () => {
          const next = !state;
          if (!confirmed(p, api, `${next ? 'START' : 'STOP'} ${p.label || p.style}?`)) return;
          api.publish(cmdTopic(p), next ? p.onPayload : p.offPayload, { retain: !!p.retain });
        });
      }
      return { onMessage(_t, raw) {
        const x = extract(raw, p.jsonPath);
        const fault = p.faultPayload && String(x).toLowerCase() === String(p.faultPayload).toLowerCase();
        state = fault ? false : isOn(x, p.onPayload);
        svg.classList.toggle('running', !!state);
        svg.classList.toggle('fault', !!fault);
        svg.style.setProperty('--pc', fault ? 'var(--alarm)' : state ? p.runColor : p.stopColor);
        st.textContent = fault ? 'FAULT' : state === null ? '—' : state ? 'RUNNING' : 'STOPPED';
      } };
    },
  },

  lamp: {
    label: 'Indicator', group: 'Display', size: [120, 110],
    defaults: { topic: '', jsonPath: '', onValue: '', onColor: '#22c55e', offColor: '#334155', blink: false, shape: 'round' },
    fields: [F.topic, F.jsonPath, { key: 'onValue', label: 'ON when payload =', type: 'text', hint: 'blank = 1/true/on/open/running or > 0' },
      { key: 'onColor', label: 'ON colour', type: 'color' }, { key: 'offColor', label: 'OFF colour', type: 'color' },
      { key: 'blink', label: 'Blink when ON', type: 'checkbox' }, { key: 'shape', label: 'Shape', type: 'select', options: ['round', 'square'] }],
    create(el, p) {
      const l = h('div', { class: 'lamp ' + (p.shape === 'square' ? 'square' : '') });
      l.style.setProperty('--lc', p.offColor);
      el.append(h('div', { class: 'lamp-wrap' }, l));
      return { onMessage(_t, raw) {
        const on = isOn(extract(raw, p.jsonPath), p.onValue);
        l.style.setProperty('--lc', on ? p.onColor : p.offColor);
        l.classList.toggle('on', !!on);
        l.classList.toggle('blink', !!on && !!p.blink);
      } };
    },
  },

  pipe: {
    label: 'Pipe', group: 'Process', size: [160, 40], frame: false,
    defaults: { shape: 'left-right', topic: '', jsonPath: '', flowWhen: '', color: '#64748b', flowColor: '#38bdf8', thickness: 10, reverse: false, alwaysFlow: false },
    fields: [
      { key: 'shape', label: 'Shape', type: 'select', options: ['left-right', 'top-bottom', 'left-bottom', 'left-top', 'right-bottom', 'right-top', 'left-right-bottom', 'left-right-top', 'top-bottom-left', 'top-bottom-right', 'left-right-top-bottom'] },
      { key: 'topic', label: 'Flow topic (optional)', type: 'topic' }, F.jsonPath,
      { key: 'flowWhen', label: 'Flowing when payload =', type: 'text', hint: 'blank = truthy or > 0' },
      { key: 'alwaysFlow', label: 'Always animate', type: 'checkbox' }, { key: 'reverse', label: 'Reverse direction', type: 'checkbox' },
      { key: 'thickness', label: 'Thickness', type: 'number' }, { key: 'color', label: 'Pipe colour', type: 'color' }, { key: 'flowColor', label: 'Flow colour', type: 'color' }],
    noTitle: true,
    create(el, p) {
      const svg = s('svg', { class: 'pipe' });
      const base = s('path', { class: 'pipe-base' }), flow = s('path', { class: 'pipe-flow' + (p.reverse ? ' rev' : '') });
      svg.append(base, flow);
      el.append(svg);
      const th = num(p.thickness) || 10;
      base.style.stroke = p.color; base.style.strokeWidth = th;
      flow.style.stroke = p.flowColor; flow.style.strokeWidth = Math.max(2, th * 0.4);
      const draw = () => {
        const W = el.clientWidth, H = el.clientHeight, cx = W / 2, cy = H / 2;
        const E = { left: [0, cy], right: [W, cy], top: [cx, 0], bottom: [cx, H] };
        const edges = p.shape.split('-');
        let d;
        if (edges.length === 2) { const [a, b] = [E[edges[0]], E[edges[1]]]; d = `M${a} L${cx},${cy} L${b}`; }
        else d = edges.map((e) => `M${cx},${cy} L${E[e]}`).join(' ');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        base.setAttribute('d', d); flow.setAttribute('d', d);
      };
      const ro = new ResizeObserver(draw); ro.observe(el); draw();
      const setFlow = (on) => svg.classList.toggle('flowing', !!on);
      setFlow(p.alwaysFlow);
      return {
        onMessage(_t, raw) { if (!p.alwaysFlow) setFlow(isOn(extract(raw, p.jsonPath), p.flowWhen)); },
        destroy() { ro.disconnect(); },
      };
    },
  },

  status: {
    label: 'Multi-state', group: 'Display', size: [200, 90],
    defaults: { topic: '', jsonPath: '', states: '0=Stopped:#64748b\n1=Running:#22c55e\n2=Fault:#ef4444' },
    fields: [F.topic, F.jsonPath, { key: 'states', label: 'States (one per line)', type: 'textarea', hint: 'value=Text:#colour' }],
    create(el, p) {
      const map = new Map();
      for (const line of String(p.states || '').split('\n')) {
        const m = line.match(/^\s*([^=]+?)\s*=\s*([^:]*?)\s*(?::\s*(#[0-9a-fA-F]{3,8}|[a-z]+))?\s*$/);
        if (m) map.set(m[1].toLowerCase(), { text: m[2], color: m[3] || '#64748b' });
      }
      const pill = h('div', { class: 'pill' }, '—');
      el.append(h('div', { class: 'pill-wrap' }, pill));
      return { onMessage(_t, raw) {
        const x = String(extract(raw, p.jsonPath) ?? '');
        const st = map.get(x.toLowerCase());
        pill.textContent = st ? st.text : x;
        pill.style.setProperty('--pc', st ? st.color : '#64748b');
      } };
    },
  },

  label: {
    label: 'Text', group: 'Layout', size: [200, 50], frame: false, noTitle: true,
    defaults: { text: 'Label', topic: '', jsonPath: '', template: '{value}', fontSize: 18, color: '', align: 'left', bold: true },
    fields: [{ key: 'text', label: 'Text', type: 'text' }, { key: 'topic', label: 'Topic (optional)', type: 'topic' }, F.jsonPath,
      { key: 'template', label: 'Template', type: 'text', hint: '{value} is replaced with the payload' },
      { key: 'fontSize', label: 'Font size', type: 'number' }, { key: 'color', label: 'Colour (blank = theme)', type: 'color' },
      { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'] }, { key: 'bold', label: 'Bold', type: 'checkbox' }],
    topics: (p) => (p.topic ? [p.topic] : []),
    create(el, p) {
      const t = h('div', { class: 'label-w', style: { fontSize: (p.fontSize || 18) + 'px', color: p.color || 'var(--text)', textAlign: p.align, fontWeight: p.bold ? 700 : 400, justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[p.align] } }, p.text);
      el.append(t);
      return { onMessage(_t, raw) { t.textContent = String(p.template || '{value}').replaceAll('{value}', extract(raw, p.jsonPath) ?? ''); } };
    },
  },

  log: {
    label: 'Message log', group: 'Display', size: [380, 220],
    defaults: { topic: '#', maxLines: 100, showTopic: true },
    fields: [{ key: 'topic', label: 'Topic filter', type: 'topic', hint: 'wildcards + and # allowed' }, { key: 'maxLines', label: 'Max lines', type: 'number' }, { key: 'showTopic', label: 'Show topic', type: 'checkbox' }],
    create(el, p) {
      const list = h('div', { class: 'log' });
      el.append(list);
      return { onMessage(topic, raw) {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
        list.append(h('div', { class: 'log-line' }, h('time', {}, new Date().toLocaleTimeString()), p.showTopic ? h('span', { class: 'log-topic' }, topic) : null, h('span', {}, raw.length > 300 ? raw.slice(0, 300) + '…' : raw)));
        while (list.childElementCount > (num(p.maxLines) || 100)) list.firstChild.remove();
        if (atBottom) list.scrollTop = list.scrollHeight;
      } };
    },
  },

  image: {
    label: 'Image', group: 'Layout', size: [300, 200], frame: false, noTitle: true,
    defaults: { url: '', fit: 'contain', opacity: 1 },
    fields: [{ key: 'url', label: 'Image URL', type: 'text', hint: 'http(s) URL or data: URI — good for a plant schematic background' },
      { key: 'fit', label: 'Fit', type: 'select', options: ['contain', 'cover', 'fill'] }, { key: 'opacity', label: 'Opacity (0–1)', type: 'number' }],
    topics: () => [],
    create(el, p) {
      el.append(p.url ? h('img', { src: p.url, class: 'img-w', style: { objectFit: p.fit, opacity: p.opacity ?? 1 }, draggable: 'false' }) : h('div', { class: 'empty-hint' }, 'Set an image URL'));
      return {};
    },
  },
};


// ---------- RIOT OPT 7.02 panels ----------
// Both read the retained optimizer status on <riot>/<id>/opt7/<run> (the controller's /api/optimization JSON).
const MSC = {0:'Mode inactive',2001:'Time On Cycle',2002:'Time On Bypass Cycle',2003:'Time Off Cycle',2004:'Time Off Bypass Cycle',2005:'Pre-Flow On Cycle',2006:'Pre-Flow Off Cycle',2007:'Critical Flow Bypass Cycle',2008:'Casing Static DP Bypass Cycle',2009:'Stable Flow',2010:'Line Pressure High Cycle',2011:'Plunger Bypass Cycle',2012:'Post Plunger Sales Cycle',2013:'Casing Bypass Cycle',2014:'Backup Time Off Cycle',2015:'Load Factor Bypass Cycle',2016:'Extended Shut-in Cycle'};
const optFmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const stampTime = (st) => { const s = String(st).padStart(8, '0'); return `${s.slice(4, 6)}:${s.slice(6, 8)}`; };   // MMDDhhmm
const tripsOf = (j) => ((j && j.plunger && j.plunger.history) || []).filter((t) => t.trip > 0).sort((a, b) => b.stamp - a.stamp);

WIDGETS.plunger = {
  label: 'Plunger lift', group: 'Process', size: [1000, 430],
  defaults: { topic: '' },
  fields: [{ key: 'topic', label: 'Optimizer status topic', type: 'topic', hint: 'riot/<id>/opt7/1' }],
  create(el, p) {
    el.classList.add('plg-host');
    el.innerHTML = `<div class="plg">
      <div class="plg-well"><svg viewBox="0 0 180 360" preserveAspectRatio="xMidYMid meet">
        <line x1="0" y1="74" x2="56" y2="74" class="plg-ground"/><line x1="90" y1="74" x2="180" y2="74" class="plg-ground"/>
        <rect x="58" y="20" width="22" height="330" class="plg-casing"/>
        <rect x="64" y="16" width="10" height="334" class="plg-tubing"/>
        <rect x="76" y="20" width="12" height="9" class="plg-sensor"/>
        <line x1="74" y1="40" x2="180" y2="40" class="plg-flowline"/>
        <g class="plg-valve" transform="translate(118 40)"><polygon points="-12,-8 0,0 -12,8"/><polygon points="12,-8 0,0 12,8"/><line x1="0" y1="0" x2="0" y2="-14"/><line x1="-7" y1="-14" x2="7" y2="-14"/></g>
        <g class="plg-plunger"><rect x="64" y="0" width="10" height="16" rx="2"/></g>
        <text x="2" y="16" class="plg-small">ARRIVAL</text><text x="180" y="34" class="plg-small" text-anchor="end">SALES</text>
        <text x="118" y="60" class="plg-small plg-vtext" text-anchor="middle"></text>
        <text x="2" y="86" class="plg-small">0 m</text><text x="2" y="348" class="plg-small plg-depth"></text>
        <text x="92" y="0" class="plg-small plg-ptext"></text>
      </svg></div>
      <div class="plg-mid">
        <div class="plg-banner">—</div>
        <div class="plg-stage">Waiting for optimizer data…</div>
        <div class="plg-tlabel"></div>
        <div class="plg-timer"><b class="plg-t1">—</b> / <span class="plg-t2">—</span> <small>min</small></div>
        <div class="plg-bar"><i></i></div>
        <div class="plg-remain"></div>
        <div class="plg-mode"></div>
        <div class="plg-err"></div>
        <div class="plg-arr-title">Plunger arrivals</div>
        <div class="plg-arr"><div><span>On time</span><b data-k="onTime">—</b></div><div><span>Early</span><b data-k="early">—</b></div><div><span>Late</span><b data-k="late">—</b></div><div><span>Failed</span><b data-k="failed">—</b></div></div>
        <div class="plg-trip"></div>
      </div>
      <div class="plg-right">
        <div class="plg-pv"><span>Casing</span><small>kPa</small><b data-pv="casing">—</b></div>
        <div class="plg-pv"><span>Tubing</span><small>kPa</small><b data-pv="tubing">—</b></div>
        <div class="plg-pv"><span>Line</span><small>kPa</small><b data-pv="line">—</b></div>
        <div class="plg-pv"><span>Gas flow</span><small>E3m3/d</small><b data-pv="flow">—</b></div>
        <dl class="plg-facts"><dt>Critical flow</dt><dd data-f="cf">—</dd><dt>Load factor</dt><dd data-f="lf">—</dd><dt>Casing − line</dt><dd data-f="cl">—</dd><dt>ESD permissive</dt><dd data-f="esd">—</dd></dl>
      </div>
      <div class="plg-foot"></div>
    </div>`;
    const $ = (s) => el.querySelector(s);
    let last = null, at = 0;
    function render() {
      const j = last; if (!j) return;
      const pv = j.pv || {}, t = j.timers || {}, c = j.config || {}, pl = j.plunger || {};
      const elapsedMin = j.running ? (Date.now() - at) / 60000 : 0;   // run the timers forward between messages
      const open = !!j.valveOpen, known = j.valveKnown !== false, msc = j.modeStatusCode;
      const esdOk = j.esd !== false;
      const offCycle = [2003, 2004, 2006, 2010, 2014, 2016].includes(msc);
      const flowing = known ? open : !offCycle && msc > 0;   // valve unknown: follow the optimizer's cycle
      const banner = j.banner || (!j.running ? 'STOPPED' : !esdOk ? 'ESD' : flowing ? 'FLOWING' : 'SHUT IN');
      const b = $('.plg-banner'); b.textContent = banner;
      b.className = 'plg-banner ' + (j.banner ? 'shutin' : !j.running ? 'stopped' : !esdOk ? 'esd' : flowing ? 'flowing' : 'shutin');
      $('.plg-stage').textContent = j.modeStatusText || MSC[msc] || '';
      const onCycle = flowing;
      const x = (onCycle ? t.timeOn : t.timeOff), y = onCycle ? c.timeOnSp : c.timeOffSp;
      const xr = Number.isFinite(x) ? (y > 0 ? Math.min(y, x + elapsedMin) : x + elapsedMin) : x;   // a finished timer stays at its setpoint
      $('.plg-tlabel').textContent = onCycle ? 'Time on' : 'Time off';
      $('.plg-t1').textContent = optFmt(xr, 1); $('.plg-t2').textContent = optFmt(y, 1);
      const pct = y > 0 && Number.isFinite(xr) ? Math.max(0, Math.min(1, xr / y)) : 0;
      $('.plg-bar i').style.width = pct * 100 + '%';
      $('.plg-remain').textContent = y > 0 && Number.isFinite(xr) ? `${onCycle ? (msc === 2012 ? 'Afterflow' : 'Flow time') : 'Shut-in'} ${optFmt(Math.max(0, y - xr), 1)} min left` : '';
      $('.plg-mode').textContent = `Mode ${j.mode ?? '—'} · ${j.modeName || ''}`;
      $('.plg-err').textContent = (j.errorCode ? `Error ${j.errorCode}${j.errorText ? ': ' + j.errorText : ''}` : 'No error') + (!known ? ` · Valve feedback unknown${j.valveNote ? ' (' + j.valveNote + ')' : ''}` : '');
      $('.plg-err').classList.toggle('warn', !known && !j.errorCode);
      $('.plg-err').classList.toggle('bad', !!j.errorCode);
      for (const k of ['onTime', 'early', 'late', 'failed']) el.querySelector(`[data-k="${k}"]`).textContent = optFmt(pl[k]);
      const trips = tripsOf(j);
      const lt = trips[0];
      $('.plg-trip').innerHTML = `${lt ? `Last trip <b>${optFmt(lt.trip, 1)} min</b> · <b>${optFmt(lt.velocity, 0)} m/min</b> &nbsp; ` : ''}Avg <b>${optFmt(pl.avgVelocity, 0)} m/min</b> · Target <b>${optFmt(c.targetVelocity, 0)} m/min</b>`;
      for (const k of ['casing', 'tubing', 'line']) el.querySelector(`[data-pv="${k}"]`).textContent = optFmt(pv[k], 0);
      el.querySelector('[data-pv="flow"]').textContent = optFmt(pv.flow, 2);
      el.querySelector('[data-f="cf"]').textContent = `${optFmt(pv.criticalFlow, 2)} E3m3/d${pv.criticalFlowManual ? ' (manual)' : ''}`;
      el.querySelector('[data-f="lf"]').textContent = `${optFmt(pv.loadFactor, 0)} %`;
      el.querySelector('[data-f="cl"]').textContent = `${optFmt(Number(pv.casing) - Number(pv.line), 0)} kPa`;
      const esdEl = el.querySelector('[data-f="esd"]'); esdEl.textContent = esdOk ? 'OK' : 'TRIPPED'; esdEl.classList.toggle('bad', !esdOk);
      // wellbore: valve colour and an approximate plunger position from the cycle (real wells have no position sensor)
      $('.plg-valve').setAttribute('class', 'plg-valve ' + (!known ? '' : open ? 'open' : 'closed'));
      $('.plg-vtext').textContent = !known ? 'UNKNOWN' : open ? 'OPEN' : 'CLOSED';
      const depth = Number(c.wellDepth);
      $('.plg-depth').textContent = Number.isFinite(depth) && depth > 0 ? `${optFmt(depth)} m` : '';
      const pos = !j.running ? null : !open ? 330 : msc === 2012 ? 22 : 190;   // bottom / rising / at surface
      const pg = $('.plg-plunger'), ptxt = $('.plg-ptext');
      if (pos === null) { pg.style.display = 'none'; ptxt.textContent = ''; }
      else { pg.style.display = ''; pg.setAttribute('transform', `translate(0 ${pos - 8})`); ptxt.setAttribute('y', pos < 60 ? 96 : pos + 4); ptxt.textContent = !open ? 'at bottom' : msc === 2012 ? '▲ at surface' : 'rising ▲'; }
      const age = Math.round((Date.now() - at) / 1000);
      $('.plg-foot').textContent = `${j.programVersion ? 'OPT ' + j.programVersion + ' · ' : ''}run ${j.run || 1} · updated ${age < 90 ? age + ' s' : Math.round(age / 60) + ' min'} ago${j.running ? ' · timers estimated between updates' : ''}`;
    }
    const tick = setInterval(render, 1000);
    return {
      onMessage(_t, raw) { try { last = JSON.parse(raw); at = last.epoch ? Math.min(Date.now(), last.epoch * 1000) : Date.now(); render(); } catch { /* not JSON */ } },
      destroy() { clearInterval(tick); },
    };
  },
};

WIDGETS.opttrend = {
  label: 'OPT trend', group: 'Process', size: [1000, 330],
  defaults: { topic: '', hours: 6 },
  fields: [{ key: 'topic', label: 'Optimizer status topic', type: 'topic', hint: 'riot/<id>/opt7/1' }, { key: 'hours', label: 'Hours', type: 'number' }],
  topics: (p) => (p.topic ? [p.topic, ...['casing', 'tubing', 'line', 'valve', 'flow'].map((k) => `${p.topic}/${k}`)] : []),
  create(el, p, api) {
    el.innerHTML = `<div class="ot"><div class="ot-chart"><canvas></canvas></div>
      <div class="ot-trips"><h4>Plunger trips</h4><table><thead><tr><th>Time</th><th>Trip min</th><th>m/min</th></tr></thead><tbody></tbody></table></div>
      <div class="ot-legend"><span class="c1">Casing</span><span class="c2">Tubing</span><span class="c3">Line</span><span class="cv">Valve open</span><b class="ot-sum"></b></div></div>`;
    const canvas = el.querySelector('canvas'), wrap = el.querySelector('.ot-chart');
    const win = (Number(p.hours) || 6) * 3600e3;
    const S = { casing: [], tubing: [], line: [], valve: [], flow: [] };
    for (const k of Object.keys(S)) api.history(`${p.topic}/${k}`).then((pts) => { S[k] = pts.map((x) => ({ t: x.t, v: Number(x.v) })).filter((x) => Number.isFinite(x.v)).concat(S[k]); draw(); });
    let raf = 0; const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    const ro = new ResizeObserver(schedule); ro.observe(wrap);
    const tick = setInterval(schedule, 30000);
    function draw() {
      const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1; if (!W || !H) return;
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      const g = canvas.getContext('2d'); g.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement), grid = css.getPropertyValue('--grid').trim(), muted = css.getPropertyValue('--muted').trim(), text = css.getPropertyValue('--text').trim();
      const now = Date.now(), t0 = now - win, L = 48, R = 8, T = 18, B = 34, VB = 12;
      const inWin = (a) => a.filter((d) => d.t >= t0 - 60e3);
      let hi = -Infinity, lo = Infinity;
      for (const k of ['casing', 'tubing', 'line']) for (const d of inWin(S[k])) { hi = Math.max(hi, d.v); lo = Math.min(lo, d.v); }
      if (!Number.isFinite(hi)) { hi = 1000; lo = 0; }
      const pad = Math.max(50, (hi - lo) * 0.08); hi += pad; lo = Math.max(0, lo - pad);
      const X = (t) => L + ((t - t0) / win) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B - VB - 6);
      g.font = '11px ui-sans-serif, system-ui'; g.lineWidth = 1;
      g.fillStyle = muted; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, y = Math.round(Y(v)) + 0.5; g.strokeStyle = grid; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.setLineDash([]); g.fillText(Math.round(v), L - 6, y); }
      g.save(); g.textAlign = 'left'; g.fillText('kPa', 4, 7); g.restore();
      // valve-open bars
      const vy = H - B - VB; g.strokeStyle = grid; g.strokeRect(L + 0.5, vy + 0.5, W - L - R - 1, VB);
      const vs = inWin(S.valve); g.fillStyle = text;
      for (let i = 0; i < vs.length; i++) if (vs[i].v > 0) { const a = Math.max(t0, vs[i].t), b = i + 1 < vs.length ? vs[i + 1].t : now; g.fillRect(X(a), vy + 3, Math.max(1, X(b) - X(a)), VB - 5); }
      // time labels
      g.fillStyle = muted; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      const hrs = win / 3600e3;
      for (let i = 6; i >= 0; i--) { const ago = win * i / 6, t = now - ago; g.fillText(!i ? 'now' : hrs >= 2 ? `-${+(ago / 3600e3).toFixed(1)}h` : `-${Math.round(ago / 60e3)}m`, Math.min(Math.max(X(t), L + 10), W - R - 12), H - B + 26); }
      // lines
      const line = (arr, dash, w) => { const a = inWin(arr); if (!a.length) return; g.strokeStyle = text; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); a.forEach((d, i) => (i ? g.lineTo(X(Math.max(d.t, t0)), Y(d.v)) : g.moveTo(X(Math.max(d.t, t0)), Y(d.v)))); g.lineTo(X(now), Y(a[a.length - 1].v)); g.stroke(); g.setLineDash([]); };
      g.save(); g.beginPath(); g.rect(L, T, W - L - R, vy - T - 4); g.clip();
      line(S.line, [2, 3], 1.4); line(S.tubing, [7, 5], 1.8); line(S.casing, [], 2.2);
      g.restore();
      // summary: cycles (valve openings) and average flow
      let cycles = 0; for (let i = 1; i < vs.length; i++) if (vs[i].v > 0 && !(vs[i - 1].v > 0) && vs[i].t >= t0) cycles++;
      const fl = inWin(S.flow).filter((d) => d.t >= t0); const avg = fl.length ? fl.reduce((s, d) => s + d.v, 0) / fl.length : NaN;
      el.querySelector('.ot-sum').textContent = `${cycles} cycle${cycles === 1 ? '' : 's'} in ${hrs >= 1 ? +hrs.toFixed(1) + ' h' : Math.round(hrs * 60) + ' min'} · avg flow ${Number.isFinite(avg) ? avg.toFixed(2) : '—'} E3m3/d`;
    }
    return {
      onMessage(topic, raw) {
        if (topic === p.topic) {
          try {
            const trips = tripsOf(JSON.parse(raw)).slice(0, 8);
            el.querySelector('.ot-trips tbody').innerHTML = trips.length ? trips.map((t) => `<tr><td>${stampTime(t.stamp)}</td><td>${optFmt(t.trip, 1)}</td><td>${optFmt(t.velocity, 0)}</td></tr>`).join('') : '<tr><td colspan="3" class="ot-none">No trips yet</td></tr>';
          } catch { /* ignore */ }
          return;
        }
        const k = topic.slice(p.topic.length + 1), v = Number(raw);
        if (S[k] && Number.isFinite(v)) { S[k].push({ t: Date.now(), v }); schedule(); }
      },
      destroy() { ro.disconnect(); clearInterval(tick); cancelAnimationFrame(raf); },
    };
  },
};
ICONS.plunger = I('<rect x="9" y="3" width="6" height="18" rx="1"/><rect x="10" y="12" width="4" height="4" fill="currentColor"/><path d="M15 6h6"/>');
ICONS.opttrend = I('<path d="M3 16l4-8 3 5 3-4 3 6 5-9"/><path d="M3 20h4M10 20h4M17 20h4"/>');

for (const [k, w] of Object.entries(WIDGETS)) { w.icon = ICONS[k]; if (w.frame === undefined) w.frame = true; }

const PALETTE = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf', '#f97316'];
export function parseSeries(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const [topic, path = '', label = '', color = ''] = l.split('|').map((x) => x.trim());
    return { topic, path, label: label || topic.split('/').slice(-2).join('/'), color: color || PALETTE[i % PALETTE.length] };
  }).filter((x) => x.topic);
}

export function widgetTopics(w) {
  const def = WIDGETS[w.type];
  if (!def) return [];
  if (def.topics) return def.topics(w.props).filter(Boolean);
  return w.props.topic ? [w.props.topic] : [];
}
