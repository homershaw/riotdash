#!/usr/bin/env node
'use strict';
// End-to-end self test: starts the server on spare ports and exercises MQTT over TCP and WebSockets.

const net = require('net');
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

  srv.kill('SIGTERM');
  for (const x of [a, b, c]) x.s.destroy();
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
