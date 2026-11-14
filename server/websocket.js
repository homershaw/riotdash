'use strict';
// Minimal RFC 6455 WebSocket server-side connection (binary frames), enough for MQTT over WebSockets.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;

class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', (e) => { this.emit('error', e); this.finish(); });
    if (head && head.length) this.onData(head);
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > MAX_FRAME) return this.close(1009);
      if (!masked) return this.close(1002); // clients must mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this.sendFrame(0xA, data); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.fragments.push(data);
        if (fin) {
          const msg = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('data', msg);
        }
      }
    }
  }

  sendFrame(opcode, data) {
    if (!this.open) return;
    const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([header, data]));
  }

  write(buf) { this.sendFrame(0x2, buf); }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code);
    try { this.sendFrame(0x8, b); } catch { /* ignore */ }
    this.socket.end();
    this.finish();
  }

  end() { this.close(1000); }
  destroy() { this.socket.destroy(); this.finish(); }
}

// Performs the HTTP upgrade handshake. Returns a WsConnection or null.
function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const protos = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  const proto = protos.find((p) => p === 'mqtt' || p === 'mqttv3.1');
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (proto) lines.push(`Sec-WebSocket-Protocol: ${proto}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  return new WsConnection(socket, head);
}

module.exports = { acceptUpgrade, WsConnection };
