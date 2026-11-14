'use strict';
// File-based persistence: dashboards, retained messages and recent topic history.

const fs = require('fs');
const path = require('path');

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function safeId(id) { return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null; }

class Store {
  constructor(dataDir, opts = {}) {
    this.dir = dataDir;
    this.dashDir = path.join(dataDir, 'dashboards');
    fs.mkdirSync(this.dashDir, { recursive: true });
    this.historyPoints = opts.historyPoints || 2000;
    this.history = new Map(); // topic -> [{t, v}]
    this.topics = new Map(); // topic -> {payload, ts, count, retained}
    this.loadHistory();
  }

  // ---------- dashboards ----------
  listDashboards() {
    return fs.readdirSync(this.dashDir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dashDir, f), 'utf8'));
        return { id: d.id, name: d.name, updated: d.updated || 0 };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }
  getDashboard(id) {
    id = safeId(id); if (!id) return null;
    const f = path.join(this.dashDir, id + '.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  saveDashboard(id, d) {
    id = safeId(id); if (!id) throw new Error('bad id');
    d.id = id;
    d.updated = Date.now();
    atomicWrite(path.join(this.dashDir, id + '.json'), JSON.stringify(d, null, 2));
    return d;
  }
  deleteDashboard(id) {
    id = safeId(id); if (!id) return false;
    const f = path.join(this.dashDir, id + '.json');
    if (fs.existsSync(f)) { fs.unlinkSync(f); return true; }
    return false;
  }

  // ---------- retained ----------
  loadRetained() {
    const f = path.join(this.dir, 'retained.json');
    if (!fs.existsSync(f)) return new Map();
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      return new Map(Object.entries(obj).map(([t, m]) => [t, { payload: Buffer.from(m.p, 'base64'), qos: m.q, ts: m.ts }]));
    } catch { return new Map(); }
  }
  saveRetained(map) {
    const obj = {};
    for (const [t, m] of map) obj[t] = { p: m.payload.toString('base64'), q: m.qos, ts: m.ts };
    atomicWrite(path.join(this.dir, 'retained.json'), JSON.stringify(obj));
  }

  // ---------- history ----------
  record(topic, payload, ts, retained) {
    if (topic.startsWith('$SYS')) return;
    let s = payload.toString('utf8');
    if (s.length > 1024) s = s.slice(0, 1024);
    const t = this.topics.get(topic) || { count: 0 };
    t.payload = s; t.ts = ts; t.count++; t.retained = retained || t.retained || false;
    this.topics.set(topic, t);
    let h = this.history.get(topic);
    if (!h) { h = []; this.history.set(topic, h); }
    h.push({ t: ts, v: s.length > 256 ? s.slice(0, 256) : s });
    if (h.length > this.historyPoints) h.splice(0, h.length - this.historyPoints);
    this.dirty = true;
  }
  getHistory(topic, since = 0) {
    const h = this.history.get(topic) || [];
    return since ? h.filter((p) => p.t >= since) : h;
  }
  listTopics() {
    return [...this.topics.entries()].map(([topic, t]) => ({ topic, payload: t.payload, ts: t.ts, count: t.count }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }
  loadHistory() {
    const f = path.join(this.dir, 'history.json');
    if (!fs.existsSync(f)) return;
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [topic, pts] of Object.entries(obj)) {
        this.history.set(topic, pts);
        const last = pts[pts.length - 1];
        if (last) this.topics.set(topic, { payload: last.v, ts: last.t, count: pts.length });
      }
    } catch { /* ignore corrupt history */ }
  }
  flushHistory() {
    if (!this.dirty) return;
    this.dirty = false;
    atomicWrite(path.join(this.dir, 'history.json'), JSON.stringify(Object.fromEntries(this.history)));
  }
}

module.exports = { Store, safeId };
