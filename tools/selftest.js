#!/usr/bin/env node
'use strict';
// End-to-end self test: starts the server on spare ports and exercises MQTT over TCP and WebSockets.

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('../server/codec');

const HTTP = 18080 + Math.floor(Math.random() * 500), MQTT = 11883 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttdash-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ http: { port: HTTP, host: '127.0.0.1' }, mqtt: { port: MQTT, host: '127.0.0.1' }, dataDir: './data', riot: { writeTimeoutMs: 1500 } }));
const srv = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], { env: { ...process.env, MQTTDASH_CONFIG: path.join(dir, 'config.json') }, stdio: ['ignore', 'pipe', 'inherit'] });

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? '✔' : '✘'} ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tcpClient(id, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(MQTT, '127.0.0.1');
    const parser = new C.Parser();
    const msgs = [], acks = [];
    s.on('connect', () => {
      let pkt = C.encodeConnect({ clientId: id, keepalive: 30 });
      if (opts.will) {
        // hand-build CONNECT with will
        const body = Buffer.concat([C.str('MQTT'), Buffer.from([4, 0x02 | 0x04 | 0x20]), C.u16(30), C.str(id), C.str(opts.will.topic), C.str(opts.will.payload)]);
        pkt = C.packet(C.TYPES.CONNECT, 0, body);
      }
      s.write(pkt);
    });
    s.on('data', (d) => {
      for (const p of parser.feed(d)) {
        if (p.type === C.TYPES.CONNACK) resolve({ s, msgs, acks });
        else if (p.type === C.TYPES.PUBLISH) msgs.push(C.decodePublish(p));
        else acks.push(p.type);
      }
    });
    s.on('error', reject);
  });
}

// MQTT over a raw WebSocket so we can add headers (e.g. pretend to come through Cloudflare)
function wsMqtt(headers, username, password) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: HTTP, path: '/mqtt', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': 'mqtt', ...headers } });
    req.on('upgrade', (res, sock) => {
      const send = (buf) => { const mask = crypto.randomBytes(4); const d = Buffer.from(buf); for (let i = 0; i < d.length; i++) d[i] ^= mask[i & 3];
        sock.write(Buffer.concat([Buffer.from([0x82, 0x80 | d.length]), mask, d])); };
      send(C.encodeConnect({ clientId: 'ws-' + Math.random().toString(16).slice(2, 8), username, password }));
      sock.on('data', (d) => { // server frames are unmasked: [0x82, len, ...payload]
        const p = d.subarray(2); if (p[0] >> 4 === C.TYPES.CONNACK) { resolve(p[3]); sock.destroy(); } });
      setTimeout(() => resolve(-1), 2000);
    });
    req.on('error', () => resolve(-2));
    req.end();
  });
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await (await fetch(`http://127.0.0.1:${HTTP}/healthz`)).json(); break; } catch { await sleep(100); } }

  const a = await tcpClient('a'), b = await tcpClient('b');
  b.s.write(C.encodeSubscribe(1, [['test/+/temp', 1], ['test/#', 0]]));
  await sleep(100);
  ok(b.acks.includes(C.TYPES.SUBACK), 'SUBACK received');

  a.s.write(C.encodePublish({ topic: 'test/room/temp', payload: '21.5', qos: 1, id: 7 }));
  await sleep(150);
  ok(a.acks.includes(C.TYPES.PUBACK), 'QoS1 PUBACK');
  ok(b.msgs.length === 1 && b.msgs[0].payload.toString() === '21.5', 'wildcard delivery, single copy for overlapping subs');

  a.s.write(C.encodePublish({ topic: 'keep/me', payload: 'hello', retain: true }));
  await sleep(100);
  const c = await tcpClient('c');
  c.s.write(C.encodeSubscribe(2, [['keep/#', 0]]));
  await sleep(150);
  ok(c.msgs.some((m) => m.topic === 'keep/me' && m.retain && m.payload.toString() === 'hello'), 'retained message on subscribe');

  // Last will
  const w = await tcpClient('w', { will: { topic: 'test/will', payload: 'gone' } });
  w.s.destroy();
  await sleep(200);
  ok(b.msgs.some((m) => m.topic === 'test/will' && m.payload.toString() === 'gone'), 'last will published on abrupt disconnect');

  // WebSocket client (Node 22 global WebSocket)
  if (typeof WebSocket !== 'undefined') {
    const got = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${HTTP}/mqtt`, ['mqtt']);
      ws.binaryType = 'arraybuffer';
      const parser = new C.Parser();
      ws.onopen = () => ws.send(C.encodeConnect({ clientId: 'wsc' }));
      ws.onmessage = (ev) => {
        for (const p of parser.feed(Buffer.from(ev.data))) {
          if (p.type === C.TYPES.CONNACK) { ws.send(C.encodeSubscribe(1, [['ws/#', 0]])); setTimeout(() => a.s.write(C.encodePublish({ topic: 'ws/x', payload: 'over-ws' })), 100); }
          if (p.type === C.TYPES.PUBLISH) { resolve(C.decodePublish(p).payload.toString()); ws.close(); }
        }
      };
      setTimeout(() => resolve(null), 2000);
    });
    ok(got === 'over-ws', 'MQTT over WebSocket round trip');
  }

  const topics = await (await fetch(`http://127.0.0.1:${HTTP}/api/topics`)).json();
  ok(topics.some((t) => t.topic === 'test/room/temp'), 'topics API lists published topic');
  const hist = await (await fetch(`http://127.0.0.1:${HTTP}/api/history?topic=test/room/temp`)).json();
  ok(hist.length === 1 && hist[0].v === '21.5', 'history API');
  const dashes = await (await fetch(`http://127.0.0.1:${HTTP}/api/dashboards`)).json();
  ok(dashes.some((d) => d.id === 'plant-demo'), 'demo dashboard seeded');
  const put = await fetch(`http://127.0.0.1:${HTTP}/api/dashboards/x1`, { method: 'PUT', body: JSON.stringify({ name: 'T', widgets: [] }) });
  ok(put.ok, 'dashboard save');
  const bad = await fetch(`http://127.0.0.1:${HTTP}/api/dashboards/..%2Fevil`, { method: 'PUT', body: '{}' });
  ok(!bad.ok, 'rejects path traversal in dashboard id');

  const get = (p, headers = {}) => fetch(`http://127.0.0.1:${HTTP}${p}`, { headers });
  // ---- RIOT controller discovery ----
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'riot-info-s31-opt.json'), 'utf8'));
  info.clientId = 'RiotP4-1C2904FFAB12';
  a.s.write(C.encodePublish({ topic: 'riot/AB12/info', payload: JSON.stringify(info), retain: true }));
  a.s.write(C.encodePublish({ topic: 'riot/AB12/status/online', payload: 'true', retain: true }));
  a.s.write(C.encodePublish({ topic: 'riot/AB12/telemetry', payload: JSON.stringify({ type: 'TELEMETRY', part: 1, parts: 1, tags: [{ name: 'M31.AI1', value: 52.5, quality: 'GOOD', eu: 'kPa' }, { name: 'M31.DI1', value: 1, quality: 'BAD', eu: '' }] }) }));
  await sleep(300);
  let rl = await (await get('/api/riots')).json();
  let dev = rl.devices.find((d) => d.id === 'AB12');
  ok(dev && dev.state === 'pending' && dev.tagCount === 27 && dev.mac === '1C:29:04:FF:AB:12', 'new controller waits for approval (27 tags, MAC from clientId)');
  const tp = await (await get('/api/topics')).json();
  ok(tp.some((t) => t.topic === 'riot/AB12/tag/M31.AI1' && t.payload === '52.5'), 'telemetry decoded to one topic per Tag');
  ok(tp.some((t) => t.topic === 'riot/AB12/quality/M31.DI1' && t.payload === 'BAD'), 'Tag quality published');
  const ap = await fetch(`http://127.0.0.1:${HTTP}/api/riots/AB12/approve`, { method: 'POST', body: JSON.stringify({ name: 'Well AB' }) });
  ok(ap.ok, 'approve');
  const page = await (await get('/api/dashboards/riot-ab12')).json();
  ok(page.name === 'Well AB' && page.widgets.some((w) => w.type === 'gauge' && w.props.topic === 'riot/AB12/tag/M31.AI2' && w.props.max === 5420), 'well page built from the description (gauge scaled to Tag range)');
  ok((await get('/api/dashboards/riots')).status === 200, 'Riots overview built');
  const pr = await fetch(`http://127.0.0.1:${HTTP}/api/riot-profiles/ESP32-S31-OPT`, { method: 'PUT', body: JSON.stringify({ labels: { 'M31.AI2': 'Tubing pressure' }, rebuild: true }) });
  const prj = await pr.json();
  const page2 = await (await get('/api/dashboards/riot-ab12')).json();
  ok(prj.rebuilt === 1 && page2.widgets.some((w) => w.props.label === 'Tubing pressure'), 'model profile name applied to every controller of that model');
  await fetch(`http://127.0.0.1:${HTTP}/api/riots/AB12`, { method: 'PUT', body: JSON.stringify({ labels: { 'M31.AI2': 'Tubing (AB)' }, rebuild: true }) });
  const page3 = await (await get('/api/dashboards/riot-ab12')).json();
  ok(page3.widgets.some((w) => w.props.label === 'Tubing (AB)'), 'per-controller name overrides the profile');
  // OPT 7.02 status → panels, trend values
  a.s.write(C.encodePublish({ topic: 'riot/AB12/opt7/1', retain: true, payload: JSON.stringify({ ok: true, running: true, mode: 8, modeName: 'Self Optimization Plunger', modeStatusCode: 2012, valveOpen: true, valveKnown: true, esd: true,
    pv: { casing: 2392, tubing: 1715, line: 700, flow: 33.26 }, timers: { timeOn: 26.2 }, plunger: { onTime: 6, early: 0, late: 0, failed: 0, history: [{ trip: 8.3, stamp: 11070804, velocity: 241 }] }, config: { timeOnSp: 32.7, targetVelocity: 230 } }) }));
  await sleep(300);
  const tp2 = await (await get('/api/topics')).json();
  ok(tp2.some((t) => t.topic === 'riot/AB12/opt7/1/casing' && t.payload === '2392') && tp2.some((t) => t.topic === 'riot/AB12/opt7/1/valve' && t.payload === '1'), 'optimizer status split out for the trend');
  const page4 = await (await get('/api/dashboards/riot-ab12')).json();
  ok(page4.widgets.some((w) => w.type === 'plunger' && w.props.topic === 'riot/AB12/opt7/1') && page4.widgets.some((w) => w.type === 'opttrend'), 'plunger lift panels added when optimizer data starts');
  const ov = await (await get('/api/dashboards/riots')).json();
  ok(ov.widgets.some((w) => w.props.topic === 'riot/AB12/opt7/1/valve'), 'overview tile shows FLOWING / SHUT IN');
  // OPT soft points (riot/<id>/opt/SPTn, as the S31 firmware sends them) → assembled panel status
  const sp = { SPT0: { 'SPT0.1': 8, 'SPT0.4': 33.26, 'SPT0.7': 8, 'SPT0.9': 2000 }, SPT1: { 'SPT1.1': 1, 'SPT1.9': 32.7, 'SPT1.11': 60 }, SPT2: { 'SPT2.12': 230 },
    SPT3: { 'SPT3.1': 0, 'SPT3.5': 0, 'SPT3.12': 14.16, 'SPT3.16': 41, 'SPT3.18': 6, 'SPT3.19': 0, 'SPT3.20': 0, 'SPT3.21': 0 },
    SPT4: { 'SPT4.1': 2012, 'SPT4.2': 11070804, 'SPT4.12': 8.3 }, SPT5: { 'SPT5.12': 2392, 'SPT5.13': 1715, 'SPT5.14': 700, 'SPT5.16': 1, 'SPT5.17': 239, 'SPT5.18': 6.5 } };
  for (const [k, v] of Object.entries(sp)) a.s.write(C.encodePublish({ topic: `riot/AB13/opt/${k}`, payload: JSON.stringify({ ts: 1794642403, seq: 8, trigger: 'interval', v }) }));
  a.s.write(C.encodePublish({ topic: 'riot/AB13/info', payload: JSON.stringify({ ...info, clientId: 'RiotP4-1C2904FFAB13' }), retain: true }));
  await sleep(200);
  for (const [k, v] of Object.entries(sp)) a.s.write(C.encodePublish({ topic: `riot/AB13/opt/${k}`, payload: JSON.stringify({ ts: 1794642403, seq: 9, trigger: 'interval', v }) }));
  await sleep(900);
  const tp3 = await (await get('/api/topics')).json();
  const st = JSON.parse((tp3.find((t) => t.topic === 'riot/AB13/opt7/1') || { payload: '{}' }).payload);
  ok(st.running === true && st.esd === true && st.valveOpen === true && st.pv?.casing === 2392 && st.modeStatusCode === 2012 && Math.abs(st.timers?.timeOn - 26.2) < 0.01 && st.plunger?.history?.[0]?.velocity > 240,
    'optimizer soft points assembled into the plunger panel status (timer 32.7 - 6.5 left = 26.2; unbound ESD not shown as tripped)');
  // The controller page scenario: OPT 7.02 running, Line Pressure High cycle, manual critical flow, M31 offline (DO tags BAD)
  a.s.write(C.encodePublish({ topic: 'riot/AB13/telemetry', payload: JSON.stringify({ type: 'TELEMETRY', part: 1, parts: 1, tags: [1, 2, 3, 4].map((n) => ({ name: `M31.DO${n}`, value: 0, quality: 'BAD', eu: '' })) }) }));
  await sleep(150);
  const sp2 = { SPT0: { 'SPT0.1': 1, 'SPT0.2': 1, 'SPT0.4': 60.9985, 'SPT0.9': 2000 }, SPT1: { 'SPT1.1': 1, 'SPT1.2': 20, 'SPT1.9': 1, 'SPT1.11': 10 },
    SPT3: { 'SPT3.0': 70200, 'SPT3.1': 0, 'SPT3.5': 0, 'SPT3.12': 17.1467 }, SPT4: { 'SPT4.1': 2010 }, SPT5: { 'SPT5.12': 1250, 'SPT5.13': 2800, 'SPT5.14': 1800, 'SPT5.16': 0, 'SPT5.20': 0 } };
  for (const [k, v] of Object.entries(sp2)) a.s.write(C.encodePublish({ topic: `riot/AB13/opt/${k}`, payload: JSON.stringify({ ts: 1794643804, v }) }));
  await sleep(900);
  const st2 = JSON.parse(((await (await get('/api/topics')).json()).find((t) => t.topic === 'riot/AB13/opt7/1') || { payload: '{}' }).payload);
  ok(st2.running && st2.esd && st2.valveKnown === false && st2.pv.criticalFlow === 20 && st2.pv.criticalFlowManual && st2.programVersion === '7.02.00' && st2.timers.timeOff === 10,
    'matches the controller page: running, ESD not used, valve unknown (M31 offline), manual critical flow 20, OPT 7.02.00');
  // A second optimizer run: opt/run2/SPTn → opt7/2, separate from run 1
  a.s.write(C.encodePublish({ topic: 'riot/AB13/opt/run2/SPT5', payload: JSON.stringify({ ts: 1794643900, v: { 'SPT5.12': 900, 'SPT5.13': 700, 'SPT5.14': 650, 'SPT5.16': 1 } }) }));
  a.s.write(C.encodePublish({ topic: 'riot/AB13/opt/run2/SPT1', payload: JSON.stringify({ ts: 1794643900, v: { 'SPT1.1': 1, 'SPT1.9': 30 } }) }));
  await sleep(900);
  const tl3 = await (await get('/api/topics')).json();
  const r2 = JSON.parse((tl3.find((t) => t.topic === 'riot/AB13/opt7/2') || { payload: '{}' }).payload);
  const r1 = JSON.parse((tl3.find((t) => t.topic === 'riot/AB13/opt7/1') || { payload: '{}' }).payload);
  ok(r2.run === 2 && r2.pv && r2.pv.casing === 900 && r2.valveOpen && r2.valveKnown && r1.pv.casing === 1250 && tl3.some((t) => t.topic === 'riot/AB13/opt/run2/v/SPT5.12'),
    'optimizer run 2 (opt/run2/SPTn) becomes opt7/2 without touching run 1');
  // Writing soft points: riotdash → opt/set, controller → opt/ack
  await fetch(`http://127.0.0.1:${HTTP}/api/riots/AB13/approve`, { method: 'POST', body: JSON.stringify({ name: 'Well 13' }) });
  const post = (b) => fetch(`http://127.0.0.1:${HTTP}/api/riots/AB13/opt/set`, { method: 'POST', body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const w0 = await post({ run: 1, values: { 'SPT1.11': 12 } });
  ok(w0.ok === false && w0.timeout, 'write with nobody listening (writes off at the controller) times out with an explanation');
  const ro = await post({ run: 1, values: { 'SPT3.1': 0 } });
  ok(ro.status === 400 && /read-only/.test(ro.error), 'read-only point refused before sending');
  const ctl = await tcpClient('ctl-ab13');
  ctl.s.write(C.encodeSubscribe(7, [['riot/AB13/opt/set', 0]]));
  ctl.s.on('data', () => setTimeout(() => {
    for (const m of ctl.msgs.splice(0)) {
      const j = JSON.parse(m.payload.toString()); const { id: wid, ...vals } = j;
      const bad = vals['SPT1.18'] !== undefined && vals['SPT1.18'] >= 99;
      ctl.s.write(C.encodePublish({ topic: 'riot/AB13/opt/ack', payload: JSON.stringify({ id: wid, ok: !bad, run: 1, written: bad ? {} : vals, error: bad ? 'Early arrival time must be less than late arrival time' : '' }) }));
    }
  }, 20));
  await sleep(200);
  const w1 = await post({ run: 1, values: { 'SPT1.11': 12 } });
  const w2 = await post({ run: 1, values: { 'SPT1.18': 99 } });
  ok(w1.ok === true && w2.ok === false && /Early arrival/.test(w2.error), 'controller ack: accepted write ok, rejected write returns its reason');
  const log = await (await get('/api/riots/AB13/writes')).json();
  ok(log.length === 3 && log[0].error && log[2].timeout && log[1].ok && log[1].by.startsWith('local') && log[1].values['SPT1.11'] === 12, 'writes are logged with who, values and result');
  // Other MQTT clients may not publish opt/set directly
  const spy = await tcpClient('spy'); spy.s.write(C.encodeSubscribe(8, [['riot/AB13/opt/set', 0]])); await sleep(150);
  a.s.write(C.encodePublish({ topic: 'riot/AB13/opt/set', payload: '{"SPT0.6":0}' })); await sleep(300);
  ok(!spy.msgs.some((m) => m.topic === 'riot/AB13/opt/set'), 'a plain MQTT client cannot publish riot/+/opt/set');
  const viaCf = await fetch(`http://127.0.0.1:${HTTP}/api/riots/AB13/opt?run=1`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  ok(viaCf.status === 401 || viaCf.status === 503 || (await viaCf.json()).writable === false, 'internet requests without a login cannot write');
  ctl.s.destroy(); spy.s.destroy();
  // Plunger cycle records: from the controller (opt/cycle) and from a CSV import
  const cyc = { v: 1, seq: 7, run: 1, mode: 2, closeTs: 1794690000, openTs: 1794691800, arriveTs: 1794692340, endTs: 1794694800, arrival: 'ontime', flowAvg: 60, end: 2005, sp: { 'SPT1.11': 30, 'SPT0.9': 2000 } };
  a.s.write(C.encodePublish({ topic: 'riot/AB13/opt/cycle', payload: JSON.stringify(cyc) }));
  a.s.write(C.encodePublish({ topic: 'riot/AB13/opt/cycle', payload: JSON.stringify(cyc) }));   // re-sent after a reconnect
  await sleep(300);
  const cy1 = await (await get('/api/cycles/AB13?days=3650')).json();
  ok(cy1.total === 1 && cy1.cycles[0].tripMin === 9 && cy1.cycles[0].velocity === 222 && cy1.cycles[0].gas === 2.083, 'controller cycle record stored once, with trip, velocity and gas worked out');
  const csv = 'well,openTs,shutInMin,flowMin,arrival,gas\nOLD 1,2026-10-01 06:30,30,50,ontime,2.08\nOLD 1,2026-10-01 07:50,30,22,LATE,0.71\nOLD 1,nope,30,22,late,0.7\n';
  const im = await (await fetch(`http://127.0.0.1:${HTTP}/api/cycles/import`, { method: 'POST', body: csv })).json();
  const im2 = await (await fetch(`http://127.0.0.1:${HTTP}/api/cycles/import`, { method: 'POST', body: csv })).json();
  const wl = await (await get('/api/cycles')).json();
  ok(im.wells['OLD 1'].added === 2 && im.errorCount === 1 && im2.wells['OLD 1'].duplicates === 2 && wl.some((w) => w.well === 'OLD 1' && w.cycles === 2), 'CSV import: rows added, a bad row reported, re-import skips duplicates');
  // Advisor on simulated wells: the healthy one is clean, each problem well gets its finding, demo wells can be removed
  await fetch(`http://127.0.0.1:${HTTP}/api/cycles/demo`, { method: 'POST' });
  const adv = async (w) => (await (await get('/api/cycles/' + encodeURIComponent(w))).json()).advisor.findings.map((f) => f.id);
  const expect = { 'DEMO Healthy': [], 'DEMO Worn plunger': ['creep'], 'DEMO Liquid loading': ['loading', 'gas-down'], 'DEMO Tubing leak': ['casing-build'], 'DEMO Line pressure': ['line-high'], 'DEMO Long shut-in': ['fast'] };
  const got = {}; for (const w of Object.keys(expect)) got[w] = await adv(w);
  ok(Object.entries(expect).every(([w, ids]) => ids.every((i) => got[w].includes(i)) && (ids.length || !got[w].length)) && !got['DEMO Line pressure'].includes('creep'),
    'Advisor finds each simulated problem, and nothing on the healthy well ' + JSON.stringify(got));
  await fetch(`http://127.0.0.1:${HTTP}/api/cycles/demo`, { method: 'DELETE' });
  ok(!(await (await get('/api/cycles')).json()).some((w) => /^DEMO /.test(w.well)), 'demo wells removed, real wells kept');
  // Pre-flow (C56E test, Mode 1): the panel follows the pre-flow timer, not the idle time on / time off timers
  const pf = async (msc, valve, extra) => {
    const v = { SPT0: { 'SPT0.1': 1, 'SPT0.5': 1 }, SPT1: { 'SPT1.1': 1, 'SPT1.9': 4, 'SPT1.11': 5, 'SPT1.15': 2, 'SPT1.16': 3 },
      SPT3: { 'SPT3.6': 0.5, 'SPT3.7': 1, 'SPT3.0': 70200 }, SPT4: { 'SPT4.1': msc }, SPT5: { 'SPT5.12': 1300, 'SPT5.13': 1200, 'SPT5.14': 650, 'SPT5.16': valve, 'SPT5.18': 4, 'SPT5.20': 5, ...extra } };
    for (const [k, x] of Object.entries(v)) a.s.write(C.encodePublish({ topic: `riot/AB14/opt/${k}`, payload: JSON.stringify({ ts: 1794700000, v: x }) }));
    await sleep(800);
    return JSON.parse(((await (await get('/api/topics')).json()).find((t) => t.topic === 'riot/AB14/opt7/1') || { payload: '{}' }).payload);
  };
  a.s.write(C.encodePublish({ topic: 'riot/AB14/info', payload: JSON.stringify({ ...info, clientId: 'RiotP4-1C2904FFAB14' }), retain: true })); await sleep(200);
  const p1 = await pf(2005, 1, {}), p2 = await pf(2006, 0, {}), p3 = await pf(2001, 1, {});
  ok(p1.activeTimer && p1.activeTimer.label === 'Pre-flow on' && p1.activeTimer.elapsed === 1.5 && p1.activeTimer.sp === 2
    && p2.activeTimer.label === 'Pre-flow off' && p2.activeTimer.elapsed === 2 && p3.activeTimer === null,
    'pre-flow on / off show their own timer (1.5 of 2, 2 of 3); time on cycle falls back to time on');
  const info2 = { ...info, clientId: 'RiotP4-AABBCCDDAB12' };
  a.s.write(C.encodePublish({ topic: 'riot/AB12/info', payload: JSON.stringify(info2), retain: true }));
  await sleep(200);
  rl = await (await get('/api/riots')).json();
  ok(rl.devices.find((d) => d.id === 'AB12').conflict, 'warns when two controllers share one ID');
  ok((await fetch(`http://127.0.0.1:${HTTP}/api/riots/AB12`, { method: 'DELETE' })).ok && (await get('/api/dashboards/riot-ab12')).status === 404, 'remove deletes the page');

  // ---- internet access (requests through Cloudflare carry cf-connecting-ip) ----
  const CF = { 'cf-connecting-ip': '203.0.113.9' };
  ok((await get('/')).status === 200, 'local browser needs no login');
  ok((await get('/', CF)).status === 503, 'internet access refused until a login exists');
  ok((await get('/healthz', CF)).status === 200, 'healthz stays open for tunnel checks');
  const add = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '../server/index.js'), 'add-user', 'alice', 'correct-horse'], { env: { ...process.env, MQTTDASH_CONFIG: path.join(dir, 'config.json') }, encoding: 'utf8' });
  ok(add.status === 0, 'add-user CLI');
  await sleep(4500); // config.json is re-read live
  const basic = (u, p) => ({ ...CF, authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  ok((await get('/', CF)).status === 401, 'internet access without login → 401');
  ok((await get('/', basic('alice', 'wrong'))).status === 401, 'wrong password → 401');
  ok((await get('/', basic('alice', 'correct-horse'))).status === 200, 'correct login → 200');
  const sess = await (await get('/api/session', basic('alice', 'correct-horse'))).json();
  ok(sess.username === 'alice' && /^session:/.test(sess.password), 'logged-in browser gets an MQTT session login');
  ok((await wsMqtt({})) === 0, 'local MQTT over WS needs no login');
  ok((await wsMqtt(CF)) === 5, 'internet MQTT without login refused');
  ok((await wsMqtt(CF, 'alice', 'nope')) === 5, 'internet MQTT with wrong password refused');
  ok((await wsMqtt(CF, 'alice', 'correct-horse')) === 0, 'internet MQTT with user login accepted');
  ok((await wsMqtt(CF, 'alice', sess.password)) === 0, 'internet MQTT with browser session login accepted');
  ok((await wsMqtt(CF, 'mallory', sess.password)) === 5, 'session login is tied to its user');

  srv.kill('SIGTERM');
  for (const x of [a, b, c]) x.s.destroy();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
