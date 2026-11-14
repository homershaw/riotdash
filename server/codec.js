'use strict';
// Minimal MQTT 3.1.1 packet codec shared by the broker and the simulator.

const TYPES = {
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, PUBREC: 5, PUBREL: 6, PUBCOMP: 7,
  SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,
};

function encodeRemLen(len) {
  const out = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return Buffer.from(out);
}

function str(s) {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
  const h = Buffer.alloc(2);
  h.writeUInt16BE(b.length);
  return Buffer.concat([h, b]);
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }

function packet(type, flags, body) {
  body = body || Buffer.alloc(0);
  return Buffer.concat([Buffer.from([(type << 4) | (flags & 0x0f)]), encodeRemLen(body.length), body]);
}

// Streaming parser: feed() chunks, get back complete packets {type, flags, body}
class Parser {
  constructor() { this.buf = Buffer.alloc(0); }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const packets = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let mult = 1, len = 0, i = 1, b;
      do {
        if (i >= this.buf.length) return packets;
        b = this.buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if (i > 5) throw new Error('Malformed remaining length');
      } while (b & 0x80);
      if (this.buf.length < i + len) break;
      const h = this.buf[0];
      packets.push({ type: h >> 4, flags: h & 0x0f, body: this.buf.subarray(i, i + len) });
      this.buf = this.buf.subarray(i + len);
    }
    return packets;
  }
}

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  bytes() { const n = this.u16(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str() { return this.bytes().toString('utf8'); }
  rest() { return this.b.subarray(this.o); }
  get left() { return this.b.length - this.o; }
}

function encodePublish({ topic, payload, qos = 0, retain = false, dup = false, id }) {
  const parts = [str(topic)];
  if (qos > 0) parts.push(u16(id));
  parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8'));
  return packet(TYPES.PUBLISH, (dup ? 8 : 0) | (qos << 1) | (retain ? 1 : 0), Buffer.concat(parts));
}

function decodePublish(p) {
  const r = new Reader(p.body);
  const qos = (p.flags >> 1) & 3;
  const topic = r.str();
  const id = qos > 0 ? r.u16() : undefined;
  return { topic, id, qos, retain: !!(p.flags & 1), dup: !!(p.flags & 8), payload: Buffer.from(r.rest()) };
}

function encodeConnect({ clientId, keepalive = 60, clean = true, username, password }) {
  let flags = clean ? 2 : 0;
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const parts = [str('MQTT'), Buffer.from([4, flags]), u16(keepalive), str(clientId)];
  if (username) parts.push(str(username));
  if (password) parts.push(str(password));
  return packet(TYPES.CONNECT, 0, Buffer.concat(parts));
}

function encodeSubscribe(id, filters) {
  const parts = [u16(id)];
  for (const [f, q] of filters) { parts.push(str(f), Buffer.from([q])); }
  return packet(TYPES.SUBSCRIBE, 2, Buffer.concat(parts));
}

// Topic matching with + and # wildcards. $-topics are not matched by leading wildcards.
function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  if (t[0].startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function validFilter(f) {
  if (!f || f.length > 65535) return false;
  const parts = f.split('/');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.includes('#') && (p !== '#' || i !== parts.length - 1)) return false;
    if (p.includes('+') && p !== '+') return false;
  }
  return true;
}

function validTopic(t) { return !!t && !t.includes('+') && !t.includes('#') && t.length <= 65535; }

module.exports = {
  TYPES, Parser, Reader, packet, str, u16, encodePublish, decodePublish, encodeConnect,
  encodeSubscribe, topicMatches, validFilter, validTopic,
};
