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
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ http: { port: HTTP, host: '127.0.0.1' }, mqtt: { port: MQTT, host: '127.0.0.1' }, dataDir: './data' }));
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
