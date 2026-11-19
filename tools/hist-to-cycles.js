#!/usr/bin/env node
'use strict';
// Turns raw well history (one reading per line: time,tag,value) into plunger cycle records (docs/cycles.md) for import.
//
//   node tools/hist-to-cycles.js <folder or .csv files…> --well "Well 1" [--out cycles.csv] [--tz -07:00]
//        [--valve BPCV] [--flow FlowCurrent] [--casing Casing] [--line Line] [--min-shut 5] [--min-flow 1] [--max-gap 60]
//
// A cycle: the valve opens (valve tag above 1 %, or flow above 0.2) after being shut for at least --min-shut minutes,
// flows, then shuts again for at least --min-shut minutes. A throttling valve that touches 0 briefly while flowing
// doesn't end the cycle. Cycles that span a gap in the data longer than --max-gap minutes are dropped.
// Gas is the flow rate (taken as E3m3/d) integrated over the flow period. The history has no plunger sensor, so arrival is "none".
// Times without an offset are read with --tz (default: as UTC).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const well = opt('well'), out = opt('out'), tz = opt('tz', 'Z');
const T = { valve: opt('valve', 'BPCV'), flow: opt('flow', 'FlowCurrent'), casing: opt('casing', 'Casing'), line: opt('line', 'Line'), tubing: opt('tubing', 'Tubing') };
const minShut = Number(opt('min-shut', 5)) * 60, maxGap = Number(opt('max-gap', 60)) * 60, minFlow = Number(opt('min-flow', 1)) * 60;
if (!well || !args.length) { console.error('usage: node tools/hist-to-cycles.js <folder or files…> --well "<name>" [--out cycles.csv] [--tz -07:00]'); process.exit(1); }

let files = [];
for (const a of args) { const st = fs.statSync(a); if (st.isDirectory()) files.push(...fs.readdirSync(a).filter((f) => /\.csv$/i.test(f)).map((f) => path.join(a, f))); else files.push(a); }
files.sort();

const toTs = (s) => { s = s.trim(); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += tz; return Date.parse(s) / 1000; };

// Running state
const last = {};                 // tag -> last value
let flowing = false, openTs = null, lastFlowTs = null, lastTs = null, gapInCycle = false;
let gas = 0, flowRate = 0, flowRateTs = null, lineMax = -Infinity, atOpen = null, prevEnd = null;
const cycles = [];
let rows = 0, outOfOrder = 0, blips = 0;

function isFlowing() { return (Number(last[T.valve]) > 1) || (Number(last[T.flow]) > 0.2); }

function closeCycle(endTs) {
  // gas: integrate the flow rate up to the close
  if (flowRateTs !== null) gas += flowRate * (endTs - flowRateTs) / 86400;
  const c = {
    closeTs: prevEnd ? prevEnd.endTs : null, openTs, endTs,
    casingOpen: atOpen.casing, lineOpen: atOpen.line, tubingOpen: atOpen.tubing,
    casingEnd: last[T.casing], lineEnd: last[T.line], tubingEnd: last[T.tubing], lineMax: Number.isFinite(lineMax) ? lineMax : undefined,
    gas: Math.round(gas * 1000) / 1000,
  };
  // a blip of the valve with no gas (under --min-flow) is not a cycle: the shut-in carries on
  if (endTs - openTs < minFlow && gas < 0.001 && prevEnd) { blips++; return; }
  const ok = prevEnd && !gapInCycle && !prevEnd.gapAfter && c.openTs - c.closeTs >= minShut;
  if (ok) cycles.push(c);
  prevEnd = { endTs, gapAfter: false };
}

function onReading(ts, tag, v) {
  if (lastTs !== null && ts < lastTs - 1) { outOfOrder++; return; }
  if (lastTs !== null && ts - lastTs > maxGap) { gapInCycle = flowing; if (prevEnd && !flowing) prevEnd.gapAfter = true; }
  lastTs = ts;
  // gas integration uses the rate in force until this reading
  if (tag === T.flow) { if (flowing && flowRateTs !== null) gas += flowRate * (ts - flowRateTs) / 86400; flowRate = Math.max(0, v); flowRateTs = ts; }
  last[tag] = v;
  if (flowing && tag === T.line) lineMax = Math.max(lineMax, v);
  const f = isFlowing();
  if (f) {
    if (!flowing) {
      // re-opened: a brief dip doesn't end the cycle
      if (openTs !== null && lastFlowTs !== null && ts - lastFlowTs < minShut && !gapInCycle) { flowing = true; }
      else {
        if (openTs !== null && lastFlowTs !== null) closeCycle(lastFlowTs);
        flowing = true; openTs = ts; gas = 0; flowRateTs = ts; flowRate = Math.max(0, Number(last[T.flow]) || 0); lineMax = Number(last[T.line]) || -Infinity; gapInCycle = false;
        atOpen = { casing: last[T.casing], line: last[T.line], tubing: last[T.tubing] };
      }
    }
    lastFlowTs = ts;
  } else if (flowing) {
    flowing = false;   // may resume within --min-shut
  }
}

function readFile(f) {
  const text = fs.readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const i = line.indexOf(','), j = line.indexOf(',', i + 1);
    if (i < 0 || j < 0) continue;
    const ts = toTs(line.slice(0, i)), v = Number(line.slice(j + 1));
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
    rows++;
    onReading(ts, line.slice(i + 1, j).trim(), v);
  }
}

for (const f of files) readFile(f);
if (flowing === false && openTs !== null && lastFlowTs !== null && lastTs - lastFlowTs >= minShut) closeCycle(lastFlowTs);

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 19) + 'Z';
const r1 = (x) => (x === undefined || x === null || !Number.isFinite(Number(x)) ? '' : Math.round(Number(x) * 10) / 10);
const head = ['well', 'closeTs', 'openTs', 'endTs', 'shutInMin', 'flowMin', 'arrival', 'casingOpen', 'tubingOpen', 'lineOpen', 'casingEnd', 'tubingEnd', 'lineEnd', 'lineMax', 'gas', 'flowAvg', 'end'];
const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
const lines = [head.join(',')];
for (const c of cycles) {
  const flowMin = (c.endTs - c.openTs) / 60;
  lines.push([q(well), iso(c.closeTs), iso(c.openTs), iso(c.endTs), r1((c.openTs - c.closeTs) / 60), r1(flowMin), 'none',
    r1(c.casingOpen), r1(c.tubingOpen), r1(c.lineOpen), r1(c.casingEnd), r1(c.tubingEnd), r1(c.lineEnd), r1(c.lineMax), c.gas, flowMin > 0 ? r1(c.gas / flowMin * 1440) : '', 'valve'].join(','));
}
if (out) fs.writeFileSync(out, lines.join('\n') + '\n'); else process.stdout.write(lines.join('\n') + '\n');

const days = cycles.length ? (cycles[cycles.length - 1].openTs - cycles[0].openTs) / 86400 : 0;
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
console.error(`${well}: ${files.length} files, ${rows} readings${outOfOrder ? `, ${outOfOrder} out of order skipped` : ''}${blips ? `, ${blips} valve blips under ${minFlow / 60} min ignored` : ''} → ${cycles.length} cycles over ${days.toFixed(0)} days`
  + (cycles.length ? ` (${(cycles.length / Math.max(days, 1)).toFixed(1)}/day, median shut-in ${r1(med(cycles.map((c) => (c.openTs - c.closeTs) / 60)))} min, median flow ${r1(med(cycles.map((c) => (c.endTs - c.openTs) / 60)))} min, gas ${r1(cycles.reduce((a, c) => a + c.gas, 0) / Math.max(days, 1))} E3m3/d)` : ''));
