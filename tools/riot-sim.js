#!/usr/bin/env node
'use strict';
// Simulated RIOT Optimization Well: publishes the same MQTT messages as an ESP32-S31-OPT controller
// (retained info, status/online with last will, telemetry in 2-Tag parts) using a real info message as template.
//   node tools/riot-sim.js [--id 7B2E] [--name "Test well"] [--interval 10] [--speed 60] [--no-opt] [--host localhost] [--port 1883] [--user u --pass p]
// Also simulates an OPT 7.02 self-optimizing plunger well (mode 8) on riot/<id>/opt7/1, --speed times faster than real time.

const net = require('net');
const path = require('path');
const C = require('../server/codec');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ID = arg('id', 'SIM1').toUpperCase(), HOST = arg('host', 'localhost'), PORT = Number(arg('port', 1883));
const INTERVAL = Number(arg('interval', 10)), USER = arg('user'), PASS = arg('pass');
const base = `riot/${ID}`;
const SPEED = Number(arg('speed', 60)), OPT = !process.argv.includes('--no-opt');

const info = require(path.join(__dirname, 'fixtures', 'riot-info-s31-opt.json'));
const mac = `1C:29:04:FF:${ID.slice(0, 2).padEnd(2, '0')}:${ID.slice(2, 4).padEnd(2, '0')}`;
info.clientId = 'RiotP4-' + mac.replace(/:/g, '');
info.mac = mac;
info.site = { name: arg('name', `Sim well ${ID}`), location: arg('location', '') };
info.topics = { info: `${base}/info`, status: `${base}/status/online`, telemetry: `${base}/telemetry`, test: `${base}/test` };
if (OPT) info.topics.opt7 = `${base}/opt7/1`;

// Plausible values
const state = {};
for (const t of info.tags) {
  const r = t.range || [0, 100];
  state[t.name] = t.type === 'digital' ? (Math.random() < 0.5 ? 1 : 0) : r[0] + (r[1] - r[0]) * (0.3 + Math.random() * 0.4);
}
state['FLOW1.RATE'] = 42; state['FLOW1.HOUR'] = 0; state['FLOW1.DAY'] = 0; state['FLOW1.GRAND'] = 12873.4; state.WELL_DEPTH = 2140;
let seq = 0, t0 = Date.now();
function step() {
  for (const t of info.tags) {
    if (t.name.startsWith('FLOW1.')) continue;
    if (t.type === 'digital') { if (!t.writable && Math.random() < 0.05) state[t.name] ^= 1; continue; }
    if (t.writable) continue;
    const r = t.range || [0, 100], span = r[1] - r[0];
    state[t.name] = Math.min(r[1], Math.max(r[0], state[t.name] + (Math.random() - 0.5) * span * 0.02));
  }
  const cycle = Math.sin((Date.now() - t0) / 120000);   // slow plunger-like cycle
  state['FLOW1.RATE'] = Math.max(0, 42 + 30 * cycle + (Math.random() - 0.5) * 3);
  const inc = state['FLOW1.RATE'] * INTERVAL / 86400;
  state['FLOW1.HOUR'] += inc; state['FLOW1.DAY'] += inc; state['FLOW1.GRAND'] += inc;
  state.DOUBLE_TUBING = state['M31.AI2'] * 2; state.TUBING_COPY = state['M31.AI7'];
}


// ---------- OPT 7.02 plunger well (mode 8, self-optimizing) ----------
const W = { open: false, msc: 2003, tOn: 0, tOff: 20, tOnSp: 24, tOffSp: 60, target: 230, depth: 2000,
  casing: 2350, tubing: 2050, line: 700, flow: 0, arrivals: { onTime: 3, early: 0, late: 0, failed: 0 }, trips: [], tripAt: 0, simMs: Date.now() };
for (let i = 0; i < 3; i++) { const trip = 7.5 + Math.random() * 1.5; W.trips.unshift({ trip, stamp: 0 }); }
const stampOf = (ms) => { const d = new Date(ms); return Number(`${d.getMonth() + 1}`.padStart(2, '0') + `${d.getDate()}`.padStart(2, '0') + `${d.getHours()}`.padStart(2, '0') + `${d.getMinutes()}`.padStart(2, '0')); };
W.trips.forEach((t, i) => { t.stamp = stampOf(Date.now() - (i + 1) * 90 * 60e3); });
function optStep(dtMin) {
  W.simMs += dtMin * 60e3;
  if (W.open) {
    W.tOn += dtMin;
    if (W.msc === 2001 && W.tOn >= W.tripAt) {           // plunger arrives
      const trip = W.tripAt; W.msc = 2012;
      const v = W.depth / trip, late = v < 120;
      W.arrivals[late ? 'late' : 'onTime']++;
      W.trips.unshift({ trip, stamp: stampOf(W.simMs) }); W.trips = W.trips.slice(0, 10);
      W.tOnSp = Math.max(15, Math.min(40, W.tOnSp + (v - W.target) / 60));   // mode 8: tune flow time to the velocity
    }
    W.casing += (1600 - W.casing) * 0.05 * dtMin; W.tubing += (1500 - W.tubing) * 0.08 * dtMin;
    W.flow = Math.max(0, 22 + (W.casing - 1600) / 40 + (Math.random() - 0.5));
    if (W.tOn >= W.tOnSp) { W.open = false; W.msc = 2003; W.tOff = 0; }
  } else {
    W.tOff += dtMin; W.flow = 0;
    W.casing += (2950 - W.casing) * 0.03 * dtMin; W.tubing += (2650 - W.tubing) * 0.035 * dtMin;
    if (W.tOff >= W.tOffSp) { W.open = true; W.msc = 2001; W.tOn = 0; W.tripAt = 6.8 + Math.random() * 2.2; }
  }
}
function optStatus() {
  return {
    ok: true, programVersion: '7.02.00', optRuns: 2, flowRuns: 1, units: { P: 'kPa', Q: 'E3m3/d', L: 'm', V: 'm/min' }, base: 44000,
    running: true, startCommand: true, waitingForFlow: false, mode: 8, modeName: 'Self Optimization Plunger', errorCode: 0, errorText: 'No error',
    modeStatusCode: W.msc, modeStatusText: { 2001: 'Time On Cycle', 2003: 'Time Off Cycle', 2012: 'Post Plunger Sales Cycle' }[W.msc],
    valveOpen: W.open, valveKnown: true, valveCommand: W.open, valveError: '', esd: true,
    pv: { casing: +W.casing.toFixed(1), casingQ: 'GOOD', tubing: +W.tubing.toFixed(1), tubingQ: 'GOOD', line: W.line + Math.round((Math.random() - 0.5) * 6), lineQ: 'GOOD',
      flow: +W.flow.toFixed(4), criticalFlow: 15.1, casingTubingDp: +(W.casing - W.tubing).toFixed(1), loadFactor: +Math.max(0, (W.casing - W.tubing) / Math.max(1, W.casing - W.line) * 100).toFixed(1) },
    timers: { timeOn: +W.tOn.toFixed(2), timeOff: +W.tOff.toFixed(2), flowTime: +W.tOn.toFixed(2), shutInTime: +W.tOff.toFixed(2) },
    plunger: { ...W.arrivals, avgVelocity: +(W.trips.reduce((s, t) => s + W.depth / t.trip, 0) / Math.max(1, W.trips.length)).toFixed(2),
      history: W.trips.map((t) => ({ trip: +t.trip.toFixed(2), stamp: t.stamp, velocity: +(W.depth / t.trip).toFixed(2) })) },
    config: { mode: 8, timeOnSp: +W.tOnSp.toFixed(2), timeOffSp: W.tOffSp, targetVelocity: W.target, wellDepth: W.depth, plungerInstalled: 1 },
    run: 1, epoch: Math.floor(Date.now() / 1000), uptimeSec: Math.floor((Date.now() - t0) / 1000),
  };
}
let lastSig = '', lastSent = 0;
function optService() {
  optStep(SPEED / 60);            // called once a second: SPEED seconds of well time
  const sig = `${W.open}|${W.msc}|${W.trips.length && W.trips[0].stamp}`;
  if (sig !== lastSig || Date.now() - lastSent >= INTERVAL * 1000) { lastSig = sig; lastSent = Date.now(); pub(`${base}/opt7/1`, JSON.stringify(optStatus()), true); }
}

let sock, connected = false;
const pub = (topic, payload, retain = false) => connected && sock.write(C.encodePublish({ topic, payload, retain }));
function sendTelemetry() {
  step(); ++seq;
  const tags = info.tags.filter((t) => t.telemetry);
  const parts = Math.ceil(tags.length / 2);
  for (let p = 0; p < parts; p++) {
    pub(`${base}/telemetry`, JSON.stringify({
      type: 'TELEMETRY', sampleSequence: seq, epoch: Math.floor(Date.now() / 1000), uptimeSec: Math.floor((Date.now() - t0) / 1000),
      part: p + 1, parts, clientId: info.clientId, firmware: info.firmware,
      tags: tags.slice(p * 2, p * 2 + 2).map((t) => ({ name: t.name, value: +Number(state[t.name]).toFixed(3), quality: 'GOOD', eu: t.units })),
    }));
  }
}

function connect() {
  sock = net.connect(PORT, HOST);
  const parser = new C.Parser();
  sock.on('connect', () => {
    const will = { topic: `${base}/status/online`, payload: 'false' };
    const flags = 0x02 | 0x04 | 0x20 | (USER ? 0x80 : 0) | (PASS ? 0x40 : 0);
    const body = [C.str('MQTT'), Buffer.from([4, flags]), C.u16(30), C.str(info.clientId), C.str(will.topic), C.str(will.payload)];
    if (USER) body.push(C.str(USER)); if (PASS) body.push(C.str(PASS));
    sock.write(C.packet(C.TYPES.CONNECT, 0, Buffer.concat(body)));
  });
  sock.on('data', (d) => {
    for (const p of parser.feed(d)) {
      if (p.type !== C.TYPES.CONNACK) continue;
      if (p.body[1] !== 0) { console.error('refused', p.body[1]); process.exit(1); }
      connected = true;
      console.log(`riot-sim ${ID} connected; telemetry every ${INTERVAL}s on ${base}/telemetry`);
      pub(`${base}/status/online`, 'true', true);
      info.epoch = Math.floor(Date.now() / 1000); info.ip = '192.168.1.' + (100 + (parseInt(ID, 16) % 100 || 7));
      pub(`${base}/info`, JSON.stringify(info), true);
      sendTelemetry();
    }
  });
  sock.on('close', () => { connected = false; setTimeout(connect, 2000); });
  sock.on('error', () => {});
  setInterval(() => connected && sock.write(C.packet(C.TYPES.PINGREQ, 0)), 20000);
}
connect();
setInterval(sendTelemetry, INTERVAL * 1000);
if (OPT) setInterval(optService, 1000);
