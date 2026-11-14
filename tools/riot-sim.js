#!/usr/bin/env node
'use strict';
// Simulated RIOT Optimization Well: publishes the same MQTT messages as an ESP32-S31-OPT controller
// (retained info, status/online with last will, telemetry in 2-Tag parts) using a real info message as template.
//   node tools/riot-sim.js [--id 7B2E] [--name "Test well"] [--interval 10] [--host localhost] [--port 1883] [--user u --pass p]

const net = require('net');
const path = require('path');
const C = require('../server/codec');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ID = arg('id', 'SIM1').toUpperCase(), HOST = arg('host', 'localhost'), PORT = Number(arg('port', 1883));
const INTERVAL = Number(arg('interval', 10)), USER = arg('user'), PASS = arg('pass');
const base = `riot/${ID}`;

const info = require(path.join(__dirname, 'fixtures', 'riot-info-s31-opt.json'));
const mac = `1C:29:04:FF:${ID.slice(0, 2).padEnd(2, '0')}:${ID.slice(2, 4).padEnd(2, '0')}`;
info.clientId = 'RiotP4-' + mac.replace(/:/g, '');
info.mac = mac;
info.site = { name: arg('name', `Sim well ${ID}`), location: arg('location', '') };
info.topics = { info: `${base}/info`, status: `${base}/status/online`, telemetry: `${base}/telemetry`, test: `${base}/test` };

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
