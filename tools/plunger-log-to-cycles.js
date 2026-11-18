#!/usr/bin/env node
'use strict';
// Builds plunger cycle records (docs/cycles.md) from two RTU exports:
//   --plunger  one row per arrival:  Time, Plunger Time (Min), WellDepth, Plunger Velocity (M/mins)   (-1 = no arrival)
//   --current  wide samples:         Time, Casing Press (kPa), Line Press (kPa), Flow Rate (e³m³/d), Flow Today (e³m³), …
//
//   node tools/plunger-log-to-cycles.js --plunger plunger.csv --current current.csv --well "08-33-052-21W5M"
//        [--tz -07:00] [--early 5] [--late 15] [--target 300] [--out cycles.csv]
//
// Each arrival row is one cycle: the valve opened at (arrival − trip time). A -1 row is a failed cycle, opened at
// the row's time. Pressures at open are the last sample before it. Gas per cycle is the rise of Flow Today from this
// cycle's open to the next one's (Flow Today resets once a day; a drop counts as a reset). The flow end is the last
// sample with flow after the open, so it is only as precise as the sample interval.
// --early / --late (minutes of trip time) classify arrivals; without them every arrival counts as on time.
// --target (m/min) is stored as the target velocity (SPT2.12) so the Advisor can check fast and slow arrivals.

const fs = require('fs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const plFile = opt('plunger'), cuFile = opt('current'), well = opt('well'), out = opt('out'), tz = opt('tz', 'Z');
const earlyArg = opt('early'), lateArg = opt('late'), targetArg = opt('target');
if (!plFile || !cuFile || !well) { console.error('usage: node tools/plunger-log-to-cycles.js --plunger <file> --current <file> --well "<name>" [--tz -07:00] [--early 5] [--late 15] [--target 300] [--out cycles.csv]'); process.exit(1); }
const early = earlyArg !== undefined ? Number(earlyArg) : null, late = lateArg !== undefined ? Number(lateArg) : null, target = targetArg !== undefined ? Number(targetArg) : null;

const toTs = (s) => { s = s.trim().replace(' ', 'T'); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += tz; return Date.parse(s) / 1000; };
const rows = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(','));

// Current samples
const cu = rows(cuFile), H = cu[0].map((h) => h.trim().toLowerCase());
const col = (re) => H.findIndex((h) => re.test(h));
const C = { casing: col(/^casing/), line: col(/^line/), rate: col(/^flow rate/), today: col(/^flow today/), crit: col(/^criticalflow|critical flow/), tubing: col(/^tubing/) };
if (C.casing < 0 || C.today < 0) { console.error('The current file needs Casing Press and Flow Today columns. Found: ' + cu[0].join(', ')); process.exit(1); }
const S = [];
for (const r of cu.slice(1)) {
  const t = toTs(r[0]); if (!Number.isFinite(t)) continue;
  const n = (i) => (i < 0 || r[i] === undefined || r[i] === '' ? undefined : Number(r[i]));
  S.push({ t, casing: n(C.casing), line: n(C.line), rate: n(C.rate), today: n(C.today), crit: n(C.crit), tubing: n(C.tubing) });
}
S.sort((a, b) => a.t - b.t);
const before = (t) => { let lo = 0, hi = S.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
// gas between two times: positive steps of Flow Today; a drop is the daily reset, so the new value counts
function gasBetween(t0, t1) {
  let k = Math.max(0, before(t0)), g = 0;
  for (let i = k + 1; i < S.length && S[i].t <= t1; i++) {
    const a = S[i - 1].today, b = S[i].today;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    g += b >= a ? b - a : b;
  }
  return g;
}

// Plunger arrivals (skip summary rows and repeated logs of the same trip)
const pl = rows(plFile), PH = pl[0].map((h) => h.trim().toLowerCase());
const pc = { trip: PH.findIndex((h) => /plunger time/.test(h)), depth: PH.findIndex((h) => /depth/.test(h)), vel: PH.findIndex((h) => /velocity/.test(h)) };
const raw = [];
for (const r of pl.slice(1)) {
  const t = toTs(r[0]); if (!Number.isFinite(t)) continue;
  raw.push({ t, trip: Number(r[pc.trip]), depth: Number(r[pc.depth]), vel: Number(r[pc.vel]) });
}
raw.sort((a, b) => a.t - b.t);
// The log sometimes repeats the last trip (same trip time and velocity) at an odd time. Such a row is dropped when it
// is off the well's normal cycle spacing: closer than 70 % of the usual interval to the row before or after it.
const arr = []; let dup = 0;
const spacing = (i) => { const g = []; for (let j = Math.max(1, i - 10); j < Math.min(raw.length, i + 10); j++) g.push(raw[j].t - raw[j - 1].t); g.sort((x, y) => x - y); return g[g.length >> 1] || 0; };
for (let i = 0; i < raw.length; i++) {
  const a = raw[i], p = arr[arr.length - 1], nx = raw[i + 1];
  if (p && a.trip > 0 && p.trip === a.trip && p.vel === a.vel) {
    const sp = spacing(i);
    if (a.t - p.t < 0.7 * sp || (nx && nx.t - a.t < 0.7 * sp)) { dup++; continue; }
  }
  arr.push(a);
}

const cycles = [];
for (let i = 0; i < arr.length; i++) {
  const a = arr[i], failed = !(a.trip > 0);
  const openTs = Math.round(failed ? a.t : a.t - a.trip * 60);
  const next = arr[i + 1], nextOpen = next ? (next.trip > 0 ? next.t - next.trip * 60 : next.t) : null;
  const k = before(openTs);
  if (k < 0 || openTs - S[k].t > 3600) continue;   // no samples around this cycle
  // flow end: last sample with flow after the open, before the next cycle
  let endTs = failed ? openTs : a.t;
  for (let j = k + 1; j < S.length && S[j].t < (nextOpen || Infinity) && S[j].t < openTs + 12 * 3600; j++) { if (S[j].rate > 0.05) endTs = Math.max(endTs, S[j].t); else if (S[j].t > a.t + 1800) break; }
  if (endTs <= openTs) endTs = openTs + 60;
  const e = before(endTs + 1), ke = e >= 0 ? S[e] : null;
  let lineMax = -Infinity; for (let j = k; j <= e; j++) if (S[j].line > lineMax) lineMax = S[j].line;
  const gas = nextOpen ? gasBetween(openTs, nextOpen) : null;
  const arrival = failed ? 'failed' : late !== null && a.trip > late ? 'late' : early !== null && a.trip < early ? 'early' : 'ontime';
  const sp = { 'SPT0.9': a.depth > 0 ? a.depth : undefined, 'SPT2.12': target || undefined };
  cycles.push({ openTs, arriveTs: failed ? 0 : Math.round(a.t), endTs: Math.round(endTs), arrival, tripMin: failed ? undefined : a.trip, velocity: failed ? undefined : Math.round(a.vel),
    casingOpen: S[k].casing, lineOpen: S[k].line, tubingOpen: S[k].tubing, casingEnd: ke && ke.casing, lineEnd: ke && ke.line, lineMax: Number.isFinite(lineMax) ? lineMax : undefined,
    gas: gas === null ? undefined : Math.round(gas * 10000) / 10000, critical: S[k].crit, sp });
}
for (let i = 0; i < cycles.length; i++) cycles[i].closeTs = i ? cycles[i - 1].endTs : undefined;

const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 19) + 'Z' : '');
const r1 = (x) => (x === undefined || x === null || !Number.isFinite(Number(x)) ? '' : Math.round(Number(x) * 10) / 10);
const head = ['well', 'closeTs', 'openTs', 'arriveTs', 'endTs', 'arrival', 'tripMin', 'velocity', 'casingOpen', 'tubingOpen', 'lineOpen', 'casingEnd', 'lineEnd', 'lineMax', 'gas', 'SPT0.9', 'SPT2.12'];
const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
const lines = [head.join(',')];
for (const c of cycles.slice(1)) {   // the first has no previous close
  lines.push([q(well), iso(c.closeTs), iso(c.openTs), iso(c.arriveTs), iso(c.endTs), c.arrival, c.tripMin ?? '', c.velocity ?? '', r1(c.casingOpen), r1(c.tubingOpen), r1(c.lineOpen), r1(c.casingEnd), r1(c.lineEnd), r1(c.lineMax), c.gas ?? '', c.sp['SPT0.9'] ?? '', c.sp['SPT2.12'] ?? ''].join(','));
}
if (out) fs.writeFileSync(out, lines.join('\n') + '\n'); else process.stdout.write(lines.join('\n') + '\n');
const n = lines.length - 1, failedN = cycles.slice(1).filter((c) => c.arrival === 'failed').length;
const days = n ? (cycles[cycles.length - 1].openTs - cycles[1].openTs) / 86400 : 0;
console.error(`${well}: ${S.length} samples, ${arr.length} plunger rows${dup ? ` (${dup} repeated rows skipped)` : ''} → ${n} cycles over ${days.toFixed(0)} days, ${failedN} failed arrivals, gas ${r1(cycles.slice(1).reduce((x, c) => x + (c.gas || 0), 0) / Math.max(1, days))} E3m3/d`);
