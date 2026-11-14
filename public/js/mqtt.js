// Tiny MQTT 3.1.1 client over WebSockets for the browser (no dependencies).
// Works against the built-in broker or any broker that speaks MQTT-over-WS.

const enc = new TextEncoder();
const dec = new TextDecoder();

function remLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
function strBytes(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function pkt(type, flags, body) { return new Uint8Array([(type << 4) | flags, ...remLen(body.length), ...body]); }

export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/'), t = topic.split('/');
  if (t[0].startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class MqttClient extends EventTarget {
  constructor(opts) {
    super();
    this.opts = { keepalive: 30, clientId: 'dash-' + Math.random().toString(16).slice(2, 10), ...opts };
    this.subs = new Map(); // filter -> qos
    this.nextId = 1;
    this.state = 'disconnected';
    this.buf = new Uint8Array(0);
    this.reconnectDelay = 1000;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setState(s, info) { this.state = s; this._emit('state', { state: s, info }); }

  connect() {
    this.stopped = false;
    clearTimeout(this.rTimer);
    this._setState('connecting');
    let ws;
    try { ws = new WebSocket(this.opts.url, ['mqtt']); } catch (e) { this._setState('error', e.message); return this._scheduleReconnect(); }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      const o = this.opts;
      let flags = 2; // clean session
      if (o.username) flags |= 0x80;
      if (o.password) flags |= 0x40;
      const body = [...strBytes('MQTT'), 4, flags, o.keepalive >> 8, o.keepalive & 255, ...strBytes(o.clientId)];
      if (o.username) body.push(...strBytes(o.username));
      if (o.password) body.push(...strBytes(o.password));
      ws.send(pkt(1, 0, body));
    };
    ws.onmessage = (ev) => this._onData(new Uint8Array(ev.data));
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this._setState('disconnected');
      if (!this.stopped) this._scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleReconnect() {
    clearTimeout(this.rTimer);
    this.rTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 15000);
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.rTimer);
    clearInterval(this.pingTimer);
    if (this.ws) { try { this.ws.send(pkt(14, 0, [])); this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this._setState('disconnected');
  }

  _onData(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1, len = 0, i = 1, b;
      do { if (i >= this.buf.length) return; b = this.buf[i++]; len += (b & 127) * mult; mult *= 128; } while (b & 128);
      if (this.buf.length < i + len) return;
      const type = this.buf[0] >> 4, flags = this.buf[0] & 15;
      const body = this.buf.slice(i, i + len);
      this.buf = this.buf.slice(i + len);
      this._handle(type, flags, body);
    }
  }

  _handle(type, flags, body) {
    if (type === 2) { // CONNACK
      if (body[1] !== 0) {
        const reasons = { 1: 'bad protocol', 2: 'bad client id', 3: 'server unavailable', 4: 'bad username/password', 5: 'not authorized' };
        this.stopped = true;
        this._setState('error', 'Connection refused: ' + (reasons[body[1]] || body[1]));
        this.ws.close();
        return;
      }
      this.reconnectDelay = 1000;
      this._setState('connected');
      this.pingTimer = setInterval(() => this._send(pkt(12, 0, [])), this.opts.keepalive * 500);
      if (this.subs.size) this._sendSubscribe([...this.subs.entries()]);
    } else if (type === 3) { // PUBLISH
      const qos = (flags >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.slice(2, 2 + tlen));
      let o = 2 + tlen, id;
      if (qos > 0) { id = (body[o] << 8) | body[o + 1]; o += 2; }
      const payload = dec.decode(body.slice(o));
      if (qos === 1) this._send(pkt(4, 0, [id >> 8, id & 255]));
      if (qos === 2) this._send(pkt(5, 0, [id >> 8, id & 255]));
      this._emit('message', { topic, payload, retain: !!(flags & 1), qos });
    } else if (type === 6) { // PUBREL
      this._send(pkt(7, 0, [body[0], body[1]]));
    }
  }

  _send(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }
  _id() { const id = this.nextId; this.nextId = (this.nextId % 65535) + 1; return id; }

  _sendSubscribe(list) {
    const id = this._id();
    const body = [id >> 8, id & 255];
    for (const [f, q] of list) body.push(...strBytes(f), q);
    this._send(pkt(8, 2, body));
  }

  subscribe(filter, qos = 0) {
    if (this.subs.has(filter)) return;
    this.subs.set(filter, qos);
    if (this.state === 'connected') this._sendSubscribe([[filter, qos]]);
  }

  unsubscribe(filter) {
    if (!this.subs.delete(filter)) return;
    if (this.state !== 'connected') return;
    const id = this._id();
    this._send(pkt(10, 2, [id >> 8, id & 255, ...strBytes(filter)]));
  }

  publish(topic, payload, { qos = 0, retain = false } = {}) {
    if (this.state !== 'connected') return false;
    const body = [...strBytes(topic)];
    if (qos > 0) { const id = this._id(); body.push(id >> 8, id & 255); }
    body.push(...enc.encode(String(payload)));
    this._send(pkt(3, (qos << 1) | (retain ? 1 : 0), body));
    return true;
  }
}
