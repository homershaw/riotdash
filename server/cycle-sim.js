'use strict';
// Demo wells for trying the Advisor: 30 days of plunger cycles ending now, each well with one known problem
// that starts partway through. A small physical model: casing builds during shut-in, velocity follows the
// casing-to-line differential, a weak cycle arrives late or fails. Wells are named "DEMO …" and records carry
// source "demo", so they can be removed without touching real data.

const SCENARIOS = {
  'DEMO Healthy': { note: 'Steady well: nothing should be flagged.' },
  'DEMO Worn plunger': { note: 'From day 16 the plunger wears: velocity creeps up about 4 %/day, less liquid lifted, gas slowly down.' },
  'DEMO Liquid loading': { note: 'From day 24 more liquid comes in: velocity falls, late and failed arrivals climb, gas drops.' },
  'DEMO Tubing leak': { note: 'From day 24 casing builds more slowly during shut-in, so arrivals slow and gas drops.' },
  'DEMO Line pressure': { note: 'From day 25 the sales line pressure rises (compressor trouble): more line-high cycles, gas drops.' },
  'DEMO Long shut-in': { note: 'Shut-in set too long all month: the plunger always arrives about 40 % too fast.' },
};

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function simulate(name, { days = 30, end = Math.floor(Date.now() / 1000), seed = 1 } = {}) {
  const R = rng(seed + name.length * 7919), n = (a = 1) => (R() + R() + R() - 1.5) * a;   // ~normal noise
  const depth = 2000, target = 200, lateSp = 15, earlySp = 5;
  const longShut = name === 'DEMO Long shut-in';
  const sp = { 'SPT0.9': depth, 'SPT1.11': longShut ? 55 : 30, 'SPT1.18': earlySp, 'SPT1.19': lateSp, 'SPT2.6': 600, 'SPT2.7': 10, 'SPT2.8': 50, 'SPT2.12': target };
  const out = [];
  let t = end - days * 86400, casingEnd = 900, seq = 1;
  while (true) {
    const d = (t - (end - days * 86400)) / 86400;
    let buildRate = 12 * (1 + n(0.05)), line = 640 + n(15), liquid = 1, bypass = 1, lineHighP = 0.04;
    if (name === 'DEMO Worn plunger' && d > 15) { bypass = 1 + 0.04 * (d - 15); }
    if (name === 'DEMO Liquid loading' && d > 23) liquid = 1 + 0.085 * (d - 23);
    if (name === 'DEMO Tubing leak' && d > 23) buildRate *= Math.max(0.6, 1 - 0.07 * (d - 23));
    if (name === 'DEMO Line pressure' && d > 24) { line += Math.min(320, 70 * (d - 24)); lineHighP = 0.45; }
    let shut = sp['SPT1.11'] * (1 + n(0.04));
    if (lineHighP > 0.2 && R() < 0.3) shut += 8 + 12 * R();   // held shut by line pressure high
    const casingOpen = casingEnd + buildRate * shut;
    const diff = casingOpen - line;
    const closeTs = Math.round(t), openTs = Math.round(t + shut * 60);
    let velocity = 210 * (diff / 620) / liquid * bypass * (1 + n(0.06));
    const weak = diff / liquid < 420 || R() < 0.01 + (liquid - 1) * 0.15;
    let arrival, tripMin, flowMin, flowAvg;
    if (weak || velocity < 70) { arrival = 'failed'; velocity = undefined; tripMin = undefined; flowMin = 8 + 6 * R(); flowAvg = 25 + n(5); }
    else {
      tripMin = depth / velocity;
      arrival = tripMin > lateSp ? 'late' : tripMin < earlySp ? 'early' : 'ontime';
      flowMin = (45 + n(8)) / Math.sqrt(liquid);
      flowAvg = 60 * Math.min(1.3, diff / 620) * Math.min(1, 680 / line) / (bypass > 1 ? Math.sqrt(bypass) : 1) * (1 + n(0.05));
    }
    const endTs = Math.round(openTs + flowMin * 60);
    if (endTs > end) break;
    const arriveTs = tripMin ? Math.round(openTs + tripMin * 60) : 0;
    const tubingOpen = casingOpen - 90 - 40 * liquid + n(10);
    casingEnd = line + 260 + 0.2 * (casingOpen - line - 620) + n(15);   // blows down towards line pressure while flowing
    const ended = arrival !== 'failed' && R() < lineHighP ? 2010 : arrival === 'failed' ? 2007 : 2005;
    out.push({ v: 1, seq: seq++, run: 1, mode: 2, closeTs, openTs, arriveTs, endTs, arrival,
      shutInMin: Math.round(shut * 10) / 10, tripMin: tripMin && Math.round(tripMin * 10) / 10, afterflowMin: tripMin ? Math.round((flowMin - tripMin) * 10) / 10 : undefined,
      flowMin: Math.round(flowMin * 10) / 10, velocity: velocity && Math.round(velocity),
      casingOpen: Math.round(casingOpen), tubingOpen: Math.round(tubingOpen), lineOpen: Math.round(line), casingEnd: Math.round(casingEnd), lineEnd: Math.round(line + n(10)),
      gas: Math.round(flowAvg * flowMin / 1440 * 1000) / 1000, flowAvg: Math.round(flowAvg * 10) / 10, end: ended, error: 0, sp, source: 'demo' });
    t = endTs + 5;
  }
  return out.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
}

module.exports = { SCENARIOS, simulate };
