'use strict';
// Zero-dependency MQTT 3.1.1 broker. Transport-agnostic: give it any duplex
// object with write(buf), end(), and 'data'/'close'/'error' events.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const C = require('./codec');
const { TYPES } = C;

function verifyPassword(user, password) {
  if (user.passwordHash) {
    // format: scrypt$<saltHex>$<hashHex>
    const [, salt, hash] = String(user.passwordHash).split('$');
    if (!salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32);
    const want = Buffer.from(hash, 'hex');
    return want.length === calc.length && crypto.timingSafeEqual(calc, want);
  }
  return user.password !== undefined && String(user.password) === String(password);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
}

class Session {
  constructor(broker, conn, transport, remote) {
    this.broker = broker;
    this.conn = conn;
    this.transport = transport;
    this.remote = remote;
    this.parser = new C.Parser();
    this.connected = false;
    this.subs = new Map(); // filter -> qos
    this.nextId = 1;
    this.inflightQos2 = new Set();
    this.will = null;
    this.lastSeen = Date.now();

    conn.on('data', (d) => this.onData(d));
    conn.on('close', () => this.onClose());
    conn.on('error', () => this.onClose());
    // Must CONNECT within 10 s
    this.connectTimer = setTimeout(() => { if (!this.connected) this.kill(); }, 10000);
  }

  send(buf) { try { this.conn.write(buf); } catch { this.kill(); } }

  kill() {
    try { this.conn.end(); } catch { /* ignore */ }
    try { this.conn.destroy && this.conn.destroy(); } catch { /* ignore */ }
    this.onClose();
  }

  onData(chunk) {
    this.lastSeen = Date.now();
    let packets;
    try { packets = this.parser.feed(chunk); } catch { return this.kill(); }
    for (const p of packets) {
      try { this.handle(p); } catch (e) { this.broker.log('protocol error', this.clientId, e.message); return this.kill(); }
    }
  }

  handle(p) {
    if (!this.connected && p.type !== TYPES.CONNECT) return this.kill();
    switch (p.type) {
      case TYPES.CONNECT: return this.onConnect(p);
      case TYPES.PUBLISH: return this.onPublish(p);
      case TYPES.PUBACK: return; // outbound QoS1 ack: nothing to retry in this broker
      case TYPES.PUBREC: return this.send(C.packet(TYPES.PUBREL, 2, p.body.subarray(0, 2)));
      case TYPES.PUBREL: {
        const id = p.body.readUInt16BE(0);
        this.inflightQos2.delete(id);
        return this.send(C.packet(TYPES.PUBCOMP, 0, C.u16(id)));
      }
      case TYPES.PUBCOMP: return;
      case TYPES.SUBSCRIBE: return this.onSubscribe(p);
      case TYPES.UNSUBSCRIBE: return this.onUnsubscribe(p);
      case TYPES.PINGREQ: return this.send(C.packet(TYPES.PINGRESP, 0));
      case TYPES.DISCONNECT: this.will = null; return this.kill();
      default: return this.kill();
    }
  }

  onConnect(p) {
    if (this.connected) return this.kill();
    const r = new C.Reader(p.body);
    const proto = r.str();
    const level = r.u8();
    if (!((proto === 'MQTT' && level === 4) || (proto === 'MQIsdp' && level === 3))) {
      this.send(C.packet(TYPES.CONNACK, 0, Buffer.from([0, 1])));
      return this.kill();
    }
    const flags = r.u8();
    this.keepalive = r.u16();
    this.clean = !!(flags & 2);
    let clientId = r.str();
    if (flags & 4) {
      this.will = { topic: r.str(), payload: Buffer.from(r.bytes()), qos: (flags >> 3) & 3, retain: !!(flags & 0x20) };
    }
    const username = flags & 0x80 ? r.str() : undefined;
    const password = flags & 0x40 ? r.bytes().toString('utf8') : undefined;

    if (!clientId) {
      if (!this.clean) { this.send(C.packet(TYPES.CONNACK, 0, Buffer.from([0, 2]))); return this.kill(); }
      clientId = 'auto-' + crypto.randomBytes(6).toString('hex');
    }

    const auth = this.broker.config.auth || {};
    if (auth.enabled) {
      const user = (auth.users || []).find((u) => u.username === username);
      if (!user || !verifyPassword(user, password)) {
        this.broker.log(`auth failed for "${username || ''}" from ${this.remote}`);
        this.send(C.packet(TYPES.CONNACK, 0, Buffer.from([0, 5])));
        return this.kill();
      }
    }

    clearTimeout(this.connectTimer);
    this.clientId = clientId;
    this.username = username;
    this.connected = true;
    this.connectedAt = Date.now();
    this.msgsIn = 0;

    // Take over existing session with same id
    const old = this.broker.sessions.get(clientId);
    let sessionPresent = false;
    if (old && old !== this) { old.will = null; old.replaced = true; old.kill(); }
    if (!this.clean && this.broker.persistentSubs.has(clientId)) {
      this.subs = new Map(this.broker.persistentSubs.get(clientId));
      sessionPresent = true;
    }
    if (this.clean) this.broker.persistentSubs.delete(clientId);
    this.broker.sessions.set(clientId, this);

    if (this.keepalive > 0) {
      this.kaTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > this.keepalive * 1500) { this.broker.log('keepalive timeout', clientId); this.kill(); }
      }, Math.max(1000, this.keepalive * 500));
    }

    this.send(C.packet(TYPES.CONNACK, 0, Buffer.from([sessionPresent ? 1 : 0, 0])));
    this.broker.log(`client connected: ${clientId} (${this.transport} ${this.remote})`);
    this.broker.emit('clientConnected', this);
  }

  onPublish(p) {
    const m = C.decodePublish(p);
    if (!C.validTopic(m.topic)) return this.kill();
    this.msgsIn++;
    if (!this.broker.canPublish(this, m.topic)) return; // silently drop (3.1.1 behaviour)
    if (m.qos === 1) this.send(C.packet(TYPES.PUBACK, 0, C.u16(m.id)));
    if (m.qos === 2) {
      this.send(C.packet(TYPES.PUBREC, 0, C.u16(m.id)));
      if (this.inflightQos2.has(m.id)) return; // duplicate
      this.inflightQos2.add(m.id);
    }
    this.broker.publish(m.topic, m.payload, { qos: m.qos, retain: m.retain, from: this.clientId });
  }

  onSubscribe(p) {
    const r = new C.Reader(p.body);
    const id = r.u16();
    const codes = [];
    const added = [];
    while (r.left > 0) {
      const filter = r.str();
      const qos = r.u8() & 3;
      if (!C.validFilter(filter)) { codes.push(0x80); continue; }
      const granted = Math.min(qos, 1);
      this.subs.set(filter, granted);
      codes.push(granted);
      added.push(filter);
    }
    if (!this.clean) this.broker.persistentSubs.set(this.clientId, new Map(this.subs));
    this.send(C.packet(TYPES.SUBACK, 0, Buffer.concat([C.u16(id), Buffer.from(codes)])));
    // Deliver retained messages
    for (const filter of added) {
      for (const [topic, msg] of this.broker.retained) {
        if (C.topicMatches(filter, topic)) this.deliver(topic, msg.payload, Math.min(msg.qos, this.subs.get(filter)), true);
      }
    }
  }

  onUnsubscribe(p) {
    const r = new C.Reader(p.body);
    const id = r.u16();
    while (r.left > 0) this.subs.delete(r.str());
    if (!this.clean) this.broker.persistentSubs.set(this.clientId, new Map(this.subs));
    this.send(C.packet(TYPES.UNSUBACK, 0, C.u16(id)));
  }

  deliver(topic, payload, qos, retain) {
    let id;
    if (qos > 0) { id = this.nextId; this.nextId = (this.nextId % 65535) + 1; }
    this.send(C.encodePublish({ topic, payload, qos, retain, id }));
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearInterval(this.kaTimer);
    if (!this.connected) return;
    if (this.broker.sessions.get(this.clientId) === this) this.broker.sessions.delete(this.clientId);
    if (this.will) {
      const w = this.will;
      this.will = null;
      this.broker.publish(w.topic, w.payload, { qos: w.qos, retain: w.retain, from: this.clientId });
    }
    if (!this.replaced) this.broker.log(`client disconnected: ${this.clientId}`);
    this.broker.emit('clientDisconnected', this);
  }
}

class Broker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.sessions = new Map();
    this.persistentSubs = new Map();
    this.retained = new Map(); // topic -> {payload, qos, ts}
    this.stats = { messagesIn: 0, started: Date.now() };
    this.quiet = false;
  }

  log(...a) { if (!this.quiet) console.log(new Date().toISOString(), '[broker]', ...a); }

  // Optional per-user ACL: config.auth.users[].publish = ["filter", ...]
  canPublish(session, topic) {
    const auth = this.config.auth || {};
    if (!auth.enabled) return true;
    const user = (auth.users || []).find((u) => u.username === session.username);
    if (!user || !Array.isArray(user.publish)) return true;
    return user.publish.some((f) => C.topicMatches(f, topic));
  }

  attach(conn, transport, remote) { return new Session(this, conn, transport, remote); }

  publish(topic, payload, { qos = 0, retain = false, from = '$internal' } = {}) {
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    if (!topic.startsWith('$SYS')) this.stats.messagesIn++;
    if (retain) {
      if (payload.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, { payload, qos: Math.min(qos, 1), ts: Date.now() });
      this.emit('retainedChanged');
    }
    for (const s of this.sessions.values()) {
      let best = -1;
      for (const [f, q] of s.subs) if (q > best && C.topicMatches(f, topic)) best = q;
      if (best >= 0) s.deliver(topic, payload, Math.min(qos, best), false);
    }
    this.emit('message', { topic, payload, qos, retain, from, ts: Date.now() });
  }

  startSysTopics(intervalSec = 10) {
    const tick = () => {
      this.publish('$SYS/broker/clients/connected', String(this.sessions.size), { retain: true });
      this.publish('$SYS/broker/messages/received', String(this.stats.messagesIn), { retain: true });
      this.publish('$SYS/broker/uptime', String(Math.round((Date.now() - this.stats.started) / 1000)), { retain: true });
    };
    tick();
    this.sysTimer = setInterval(tick, intervalSec * 1000);
  }
}

module.exports = { Broker, hashPassword, verifyPassword };
