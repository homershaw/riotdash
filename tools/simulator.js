#!/usr/bin/env node
'use strict';
// Process simulator: publishes a small tank/pump/valve plant to MQTT and reacts to commands.
// Usage: node tools/simulator.js [--host localhost] [--port 1883] [--user u --pass p]

const net = require('net');
const C = require('../server/codec');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HOST = arg('host', 'localhost'), PORT = Number(arg('port', 1883)), USER = arg('user'), PASS = arg('pass');

const S = {
  level: 40, temp: 35, setpoint: 45, inlet: true, outlet: true, pump: false, heater: false, mode: 1, alarm: false,
  inflow: 0, outflow: 0, pressure: 0,
};
const noise = (a) => (Math.random() - 0.5) * 2 * a;

let sock, connected = false, ping, nextId = 1;
const pub = (topic, payload, retain = false) => { if (connected) sock.write(C.encodePublish({ topic, payload: String(payload), retain })); };

function publishStates() {
  pub('plant/inlet_valve/state', S.inlet ? 'OPEN' : 'CLOSED', true);
  pub('plant/outlet_valve/state', S.outlet ? 'OPEN' : 'CLOSED', true);
  pub('plant/pump1/state', S.pump ? 'ON' : 'OFF', true);
  pub('plant/heater/state', S.heater ? 'ON' : 'OFF', true);
  pub('plant/mode', S.mode, true);
  pub('plant/setpoint/temp', S.setpoint, true);
  pub('plant/alarm/high_level', S.alarm ? 1 : 0, true);
}

function onCommand(topic, msg) {
  const on = ['1', 'on', 'open', 'true', 'start'].includes(msg.trim().toLowerCase());
  const manual = () => { if (S.mode === 1) S.mode = 0; };
  switch (topic) {
    case 'plant/inlet_valve/set': manual(); S.inlet = on; break;
    case 'plant/outlet_valve/set': manual(); S.outlet = on; break;
    case 'plant/pump1/set': manual(); S.pump = on; break;
    case 'plant/mode/set': S.mode = on ? 1 : 0; break;
    case 'plant/setpoint/temp/set': { const v = Number(msg); if (Number.isFinite(v)) S.setpoint = Math.max(0, Math.min(100, v)); break; }
    case 'plant/alarm/reset': if (S.level < 93) S.alarm = false; break;
    default: return;
  }
  console.log(`cmd ${topic} = ${msg}`);
  publishStates();
}

function step() {
  // Level controller (auto mode)
  if (S.mode === 1) {
    if (S.level < 30) S.inlet = true;
    if (S.level > 90) S.inlet = false;
    if (S.level > 60) S.pump = true;
    if (S.level < 25) S.pump = false;
    S.outlet = true;
  }
  S.inflow = S.inlet ? 18 + noise(1.2) : 0;
  S.outflow = S.pump && S.outlet && S.level > 1 ? 12 + noise(0.8) : 0;
  S.level = Math.max(0, Math.min(100, S.level + ((S.inflow - S.outflow) / 60 / 50) * 100));
  if (S.level >= 93) S.alarm = true;
  // Thermostat
  if (S.temp < S.setpoint - 1) S.heater = true;
  if (S.temp > S.setpoint + 1) S.heater = false;
  S.temp += (S.heater ? 0.25 : 0) - (S.temp - 18) * 0.004 - S.inflow * 0.002 + noise(0.03);
  S.pressure = S.pump && S.outlet ? 5.4 + (S.level / 100) * 0.9 + noise(0.12) : S.pump ? 8.9 + noise(0.1) : 0.2 + Math.abs(noise(0.05));

  pub('plant/tank1/level', S.level.toFixed(2), true);
  pub('plant/tank1/temp', S.temp.toFixed(2), true);
  pub('plant/flow/inlet', S.inflow.toFixed(2));
  pub('plant/flow/outlet', S.outflow.toFixed(2));
  pub('plant/pressure', S.pressure.toFixed(3));
  publishStates();
}

let tick = 0;
function room() {
  tick++;
  pub('sensors/room1', JSON.stringify({ temp: +(21.5 + Math.sin(tick / 20) * 1.8 + noise(0.1)).toFixed(2), hum: +(45 + Math.cos(tick / 30) * 8 + noise(0.5)).toFixed(1), battery: 87 }), true);
}

function connect() {
  sock = net.connect(PORT, HOST);
  const parser = new C.Parser();
  sock.on('connect', () => sock.write(C.encodeConnect({ clientId: 'plant-simulator', keepalive: 30, username: USER, password: PASS })));
  sock.on('data', (d) => {
    for (const p of parser.feed(d)) {
      if (p.type === C.TYPES.CONNACK) {
        if (p.body[1] !== 0) { console.error('connection refused, code', p.body[1]); process.exit(1); }
        connected = true;
        console.log(`simulator connected to ${HOST}:${PORT}`);
        sock.write(C.encodeSubscribe(nextId++, [['plant/+/set', 0], ['plant/+/+/set', 0], ['plant/alarm/reset', 0]]));
        ping = setInterval(() => sock.write(C.packet(C.TYPES.PINGREQ, 0)), 20000);
        publishStates();
      } else if (p.type === C.TYPES.PUBLISH) {
        const m = C.decodePublish(p);
        if (m.qos === 1) sock.write(C.packet(C.TYPES.PUBACK, 0, C.u16(m.id)));
        onCommand(m.topic, m.payload.toString());
      }
    }
  });
  const retry = () => { connected = false; clearInterval(ping); setTimeout(connect, 2000); };
  sock.on('close', retry);
  sock.on('error', (e) => console.error('sim:', e.message));
}

connect();
setInterval(step, 1000);
setInterval(room, 5000);
