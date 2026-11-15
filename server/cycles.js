'use strict';
// Plunger cycle records (docs/cycles.md): one record per cycle, kept per well in data/cycles/<well>.jsonl.
// Sources: the controller's <prefix>/<id>/opt/cycle (opt/run2/cycle) messages, and CSV imports of other wells' history.
// Files are append-only and small (≈ 50 cycles/day/well ≈ 6 MB/well/year), loaded into memory on demand.

const fs = require('fs');
const path = require('path');

const NUM = ['v', 'seq', 'run', 'mode', 'closeTs', 'openTs', 'arriveTs', 'endTs', 'shutInMin', 'tripMin', 'afterflowMin', 'flowMin', 'velocity',
  'casingOpen', 'tubingOpen', 'lineOpen', 'loadFactorOpen', 'casingArrive', 'tubingArrive', 'casingEnd', 'tubingEnd', 'lineEnd', 'lineMax',
  'gas', 'flowAvg', 'error'];
const ARRIVALS = ['ontime', 'early', 'late', 'failed', 'none'];
const safeName = (w) => String(w).trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);

// "2026-11-14 13:52", "2026-11-14T13:52:00-06:00" or epoch seconds/ms → epoch seconds
function toEpoch(x) {
  if (x === undefined || x === null || x === '') return undefined;
  if (typeof x === 'number' || /^\d+(\.\d+)?$/.test(String(x).trim())) { const n = Number(x); return n > 1e11 ? Math.round(n / 1000) : n; }
  let s = String(x).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.round(t / 1000) : NaN;
}

// Checks and completes a record; throws with a readable reason.
function normalize(raw) {
  const r = { v: 1, run: 1 };
  const sp = {};
  for (const [k, val] of Object.entries(raw || {})) {
    if (val === '' || val === null || val === undefined) continue;
    if (/^SPT\d+\.\d+$/.test(k)) { const n = Number(val); if (Number.isFinite(n)) sp[k] = n; continue; }
    if (k === 'sp' && typeof val === 'object') { for (const [a, b] of Object.entries(val)) if (/^SPT\d+\.\d+$/.test(a) && Number.isFinite(Number(b))) sp[a] = Number(b); continue; }
    if (/Ts$/.test(k)) { const t = toEpoch(val); if (Number.isNaN(t)) throw new Error(`${k}: "${val}" is not a time`); r[k] = t; continue; }
    if (NUM.includes(k)) { const n = Number(val); if (!Number.isFinite(n)) throw new Error(`${k}: "${val}" is not a number`); r[k] = n; continue; }
    if (k === 'arrival') { const a = String(val).toLowerCase().replace(/[\s_-]/g, ''); r.arrival = a === 'ontime' ? 'ontime' : ARRIVALS.includes(a) ? a : undefined; if (!r.arrival) throw new Error(`arrival: "${val}" (use ontime, early, late, failed or none)`); continue; }
    if (k === 'end') { r.end = /^\d+$/.test(String(val)) ? Number(val) : String(val).slice(0, 40); continue; }
    if (k === 'well' || k === 'source') { r[k] = String(val).trim(); continue; }
  }
  if (Object.keys(sp).length) r.sp = sp;
  if (!r.openTs) throw new Error('openTs is missing');
  if (r.shutInMin === undefined && r.closeTs) r.shutInMin = Math.round((r.openTs - r.closeTs) / 6) / 10;
  if (r.closeTs === undefined && r.shutInMin !== undefined) r.closeTs = Math.round(r.openTs - r.shutInMin * 60);
  if (r.flowMin === undefined && r.endTs) r.flowMin = Math.round((r.endTs - r.openTs) / 6) / 10;
  if (r.endTs === undefined && r.flowMin !== undefined) r.endTs = Math.round(r.openTs + r.flowMin * 60);
  if (r.shutInMin === undefined) throw new Error('shutInMin or closeTs is missing');
  if (r.flowMin === undefined) throw new Error('flowMin or endTs is missing');
  if (r.tripMin === undefined && r.arriveTs) r.tripMin = Math.round((r.arriveTs - r.openTs) / 6) / 10;
  if (r.afterflowMin === undefined && r.arriveTs && r.endTs) r.afterflowMin = Math.round((r.endTs - r.arriveTs) / 6) / 10;
  if (!r.arrival) r.arrival = r.arriveTs ? 'ontime' : 'none';
  if (r.velocity === undefined && r.tripMin > 0 && sp['SPT0.9'] > 0) r.velocity = Math.round(sp['SPT0.9'] / r.tripMin);
  if (r.gas === undefined && r.flowAvg !== undefined) r.gas = Math.round(r.flowAvg * r.flowMin / 1440 * 1000) / 1000;
  return r;
}

// Minimal RFC 4180 CSV parser (quoted fields, commas, CRLF)
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

class Cycles {
  constructor({ dir, log = console.log }) {
    this.dir = path.join(dir, 'cycles');
    fs.mkdirSync(this.dir, { recursive: true });
    this.log = log;
    this.cache = new Map();   // well -> { records: [], keys: Set }
  }

  file(well) { return path.join(this.dir, safeName(well) + '.jsonl'); }
  key(r) { return r.seq !== undefined && r.source !== 'import' ? `${r.run}/s${r.seq}` : `${r.run}/o${r.openTs}`; }

  load(well) {
    well = safeName(well);
    let size = 0; try { size = fs.statSync(this.file(well)).size; } catch { /* none yet */ }
    let c = this.cache.get(well);
    if (c && c.size === size) return c;
    c = { records: [], keys: new Set(), size };
    try {
      for (const line of fs.readFileSync(this.file(well), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); c.records.push(r); c.keys.add(this.key(r)); c.keys.add(`${r.run}/o${r.openTs}`); } catch { /* skip a bad line */ }
      }
    } catch { /* no file yet */ }
    c.records.sort((a, b) => a.openTs - b.openTs);
    this.cache.set(well, c);
    return c;
  }

  // Adds records for one well; returns { added, duplicates }
  add(well, records) {
    const c = this.load(well);
    const lines = []; let dup = 0;
    for (const r of records) {
      const k = this.key(r), ko = `${r.run}/o${r.openTs}`;
      if (c.keys.has(k) || c.keys.has(ko)) { dup++; continue; }
      c.keys.add(k); c.keys.add(ko);
      const rec = { ...r, well };
      c.records.push(rec); lines.push(JSON.stringify(rec));
    }
    if (lines.length) {
      fs.appendFileSync(this.file(well), lines.join('\n') + '\n');
      try { c.size = fs.statSync(this.file(well)).size; } catch { /* ignore */ }
      c.records.sort((a, b) => a.openTs - b.openTs);
    }
    return { added: lines.length, duplicates: dup };
  }

  // From MQTT: <prefix>/<id>/opt/cycle (run from the topic unless the record says)
  onMessage(id, run, text) {
    let j; try { j = JSON.parse(text); } catch { return; }
    try { const r = normalize({ run, ...j, source: 'controller' }); this.add(id, [r]); } catch (e) { this.log(`[cycles] ${id}: record ignored: ${e.message}`); }
  }

  // CSV text → { wells: {name: {added, duplicates}}, rows, errors: [{line, error}] }
  importCsv(text, { defaultWell } = {}) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('The CSV needs a header row and at least one cycle');
    const head = rows[0].map((h) => h.trim());
    if (!head.includes('openTs')) throw new Error('The CSV has no openTs column');
    if (!head.includes('well') && !defaultWell) throw new Error('The CSV has no well column');
    const byWell = new Map(), errors = [];
    rows.slice(1).forEach((cells, i) => {
      const o = {}; head.forEach((h, k) => { o[h] = cells[k] === undefined ? '' : cells[k].trim(); });
      try {
        const well = (o.well || defaultWell || '').trim();
        if (!well) throw new Error('well is empty');
        const r = normalize({ ...o, source: 'import' });
        delete r.well;
        if (!byWell.has(well)) byWell.set(well, []);
        byWell.get(well).push(r);
      } catch (e) { if (errors.length < 50) errors.push({ line: i + 2, error: e.message }); }
    });
    const wells = {};
    for (const [w, recs] of byWell) wells[w] = this.add(w, recs);
    return { rows: rows.length - 1, wells, errors, errorCount: errors.length };
  }

  wells() {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const c = this.load(f.slice(0, -6));
      const n = c.records.length;
      if (n) out.push({ well: c.records[n - 1].well || f.slice(0, -6), key: f.slice(0, -6), cycles: n, first: c.records[0].openTs, last: c.records[n - 1].openTs });
    }
    return out.sort((a, b) => a.well.localeCompare(b.well));
  }

  // Deletes a well's records (used for the demo wells)
  remove(well) {
    try { fs.unlinkSync(this.file(well)); } catch { /* none */ }
    this.cache.delete(safeName(well));
  }

  list(well, { since = 0, until = Infinity, run } = {}) {
    return this.load(well).records.filter((r) => r.openTs >= since && r.openTs < until && (!run || r.run === run));
  }

  // One row per day (by UTC offset minutes): cycles, gas, arrivals, averages
  daily(well, { days = 30, tzOffsetMin = 0, run } = {}) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const by = new Map();
    for (const r of this.list(well, { since, run })) {
      const day = new Date((r.openTs + tzOffsetMin * 60) * 1000).toISOString().slice(0, 10);
      let d = by.get(day);
      if (!d) by.set(day, d = { day, cycles: 0, gas: 0, gasN: 0, shutIn: 0, flow: 0, vel: [], ontime: 0, early: 0, late: 0, failed: 0, none: 0, lineHigh: 0 });
      d.cycles++; d.shutIn += r.shutInMin || 0; d.flow += r.flowMin || 0;
      if (r.gas !== undefined) { d.gas += r.gas; d.gasN++; }
      if (r.velocity > 0) d.vel.push(r.velocity);
      d[r.arrival in d ? r.arrival : 'none']++;
      if (r.end === 2010 || r.end === 2016) d.lineHigh++;
    }
    return [...by.values()].sort((a, b) => b.day.localeCompare(a.day)).map((d) => ({
      day: d.day, cycles: d.cycles, gas: d.gasN ? Math.round(d.gas * 1000) / 1000 : null,
      avgShutInMin: Math.round(d.shutIn / d.cycles * 10) / 10, avgFlowMin: Math.round(d.flow / d.cycles * 10) / 10,
      avgVelocity: d.vel.length ? Math.round(d.vel.reduce((a, b) => a + b, 0) / d.vel.length) : null,
      ontime: d.ontime, early: d.early, late: d.late, failed: d.failed, none: d.none, lineHighCycles: d.lineHigh,
    }));
  }
}

module.exports = { Cycles, normalize, parseCsv, toEpoch, safeName };
