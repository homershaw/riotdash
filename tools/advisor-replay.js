#!/usr/bin/env node
'use strict';
// Replays the Advisor over a well's whole cycle history, one day at a time, and lists when each finding started and
// cleared. Use it to judge the Advisor against what you know happened at the well.
//
//   node tools/advisor-replay.js "<well>"            (a well already in riotdash's data folder)
//   node tools/advisor-replay.js --csv cycles.csv     (a cycle CSV, e.g. from tools/hist-to-cycles.js)
//   options: --data <riotdash data folder> (default ./data)   --tz -07:00 (dates shown in this offset, default UTC)

const fs = require('fs');
const path = require('path');
const { Cycles, normalize, parseCsv } = require('../server/cycles');
const { evaluate } = require('../server/advisor');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const csv = opt('csv'), dataDir = opt('data', path.join(__dirname, '..', 'data')), tz = opt('tz', '+00:00');
const off = (() => { const m = /^([+-])(\d\d):?(\d\d)$/.exec(tz); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60 : 0; })();

let groups = {};
if (csv) {
  const rows = parseCsv(fs.readFileSync(csv, 'utf8')), h = rows[0].map((x) => x.trim());
  for (const c of rows.slice(1)) {
    const o = Object.fromEntries(h.map((k, i) => [k, c[i]]));
    try { const r = normalize(o); (groups[o.well || 'well'] = groups[o.well || 'well'] || []).push(r); } catch { /* skip */ }
  }
} else {
  if (!args[0]) { console.error('usage: node tools/advisor-replay.js "<well>" | --csv cycles.csv'); process.exit(1); }
  groups[args[0]] = new Cycles({ dir: dataDir, log: () => {} }).list(args[0]);
}

const day = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
for (const [well, recs] of Object.entries(groups)) {
  recs.sort((a, b) => a.openTs - b.openTs);
  if (recs.length < 50) { console.log(`${well}: only ${recs.length} cycles`); continue; }
  console.log(`\n${well}: ${recs.length} cycles, ${day(recs[0].openTs)} to ${day(recs[recs.length - 1].openTs)}`);
  const open = new Map(), count = {};
  let i = 0;
  const t0 = recs[0].openTs + 16 * 86400, t1 = recs[recs.length - 1].openTs;
  for (let t = t0; t <= t1; t += 86400) {
    while (i < recs.length && recs[i].openTs <= t) i++;
    const e = evaluate(recs.slice(0, i), { now: t });
    const cur = new Map(e.findings.map((f) => [f.id, f]));
    for (const [id, f] of cur) if (!open.has(id)) { open.set(id, { from: t, f }); console.log(`  ${day(t)}  ${f.severity.toUpperCase().padEnd(5)} ${f.title}: ${f.detail}`); }
    for (const [id, o] of open) if (!cur.has(id)) { count[id] = (count[id] || 0) + Math.round((t - o.from) / 86400); console.log(`  ${day(t)}  clear ${o.f.title} (${Math.round((t - o.from) / 86400)} d)`); open.delete(id); }
  }
  const days = Math.round((t1 - t0) / 86400);
  console.log(`  days flagged out of ${days}: ` + (Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
}
