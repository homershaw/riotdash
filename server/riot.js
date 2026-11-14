'use strict';
// RIOT controller discovery and decoding.
//
// A controller publishes under <prefix>/<id>/ (prefix "riot", id = last four of its MAC):
//   info            retained JSON description: model, site, I/O and every Tag (name, units, type, range, writable…)
//   status/online   retained "true" / "false" (last will)
//   telemetry       {"type":"TELEMETRY","part":k,"parts":n,"tags":[{"name","value","quality","eu"}…]}  (2 Tags per message)
//   opt/SPTn        {"v":{"SPTn.p":value…}}       opt/meta/SPTn  {"points":{"SPTn.p":{"name","units","rw"}}}
//   opt7/<run>      retained OPT 7.02 status (same JSON as the controller's /api/optimization): drives the
//                   Plunger lift panel; casing/tubing/line/flow/valve are also split out for the 6 h trend.
//
// New controllers wait for approval. Telemetry of pending and approved controllers is decoded into one retained
// topic per Tag so ordinary widgets, trends and the Explorer work on it:
//   <prefix>/<id>/tag/<Tag name>        value            <prefix>/<id>/quality/<Tag name>   GOOD / BAD / …
//   <prefix>/<id>/opt/v/<SPTn.p>        value            <prefix>/<id>/meta/lastData         ISO time of the last telemetry

const fs = require('fs');
const path = require('path');
const pages = require('./riot-pages');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function atomicWrite(file, data) { const t = file + '.tmp'; fs.writeFileSync(t, data); fs.renameSync(t, file); }
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
const macFromClientId = (cid) => { const m = /([0-9A-Fa-f]{12})$/.exec(cid || ''); return m ? m[1].toUpperCase().match(/../g).join(':') : null; };

class Riots {
  constructor({ broker, store, config, log = console.log }) {
    this.broker = broker; this.store = store; this.config = config; this.log = log;
    this.file = path.join(store.dir, 'riots.json');
    this.profilesFile = path.join(store.dir, 'riot-profiles.json');
    this.db = readJson(this.file, { devices: {} });
    this.profiles = readJson(this.profilesFile, {});
    this.quality = new Map(); // `${id}/${tag}` -> last quality published
    this.dirty = false;
    broker.on('message', (m) => { try { this.onMessage(m); } catch (e) { this.log('[riot] ' + e.message); } });
    setInterval(() => this.flush(), 5000).unref();
  }

  get prefix() { return (this.config.riot && this.config.riot.prefix) || 'riot'; }
  flush() { if (!this.dirty) return; this.dirty = false; atomicWrite(this.file, JSON.stringify(this.db, null, 2)); }
  saveProfiles() { atomicWrite(this.profilesFile, JSON.stringify(this.profiles, null, 2)); }

  device(id) { return this.db.devices[id]; }
  ensure(id) {
    let d = this.db.devices[id];
    if (!d) {
      d = this.db.devices[id] = { id, state: 'pending', firstSeen: Date.now(), lastSeen: Date.now(), online: null, name: '', labels: {} };
      this.log(`[riot] new controller ${id} waiting for approval`);
      this.dirty = true;
    }
    return d;
  }

  onMessage(m) {
    const p = this.prefix + '/';
    if (!m.topic.startsWith(p)) return;
    const parts = m.topic.slice(p.length).split('/');
    const id = parts[0], rest = parts.slice(1).join('/');
    if (!ID_RE.test(id) || !rest) return;
    // our own decoded output: ignore
    if (rest.startsWith('tag/') || rest.startsWith('quality/') || rest.startsWith('meta/') || rest.startsWith('opt/v/') || /^opt7\/\d+\/./.test(rest)) return;
    const text = m.payload.toString('utf8');
    if (rest === 'info') return this.onInfo(id, text);
    const d = this.db.devices[id];
    if (rest === 'status/online') {
      if (!d) return;   // a status without a description doesn't make a controller
      d.online = /^(true|1|online)$/i.test(text.trim());
      d.lastSeen = Date.now(); this.dirty = true;
      return;
    }
    if (!d || d.state === 'rejected') return;
    if (rest === 'telemetry') return this.onTelemetry(d, text);
    if (/^opt\/meta\/SPT\d+$/.test(rest)) return this.onOptMeta(d, text);
    if (/^opt\/SPT\d+$/.test(rest)) return this.onOpt(d, text);
    if (/^opt7\/\d+$/.test(rest)) return this.onOpt7(d, Number(rest.split('/')[1]), text);
  }

  onInfo(id, text) {
    if (!text.trim()) return;   // retained info cleared
    let info;
    try { info = JSON.parse(text); } catch { return; }
    if (!info || info.type !== 'INFO' || !Array.isArray(info.tags)) return;
    const d = this.ensure(id);
    const mac = info.mac || macFromClientId(info.clientId);
    // Two physical controllers sharing one id (same last four of the MAC)?
    if (d.info && d.info.clientId && info.clientId && d.info.clientId !== info.clientId) {
      d.conflict = { otherClientId: info.clientId, at: Date.now() };
      this.log(`[riot] WARNING: ${id} is used by two controllers (${d.info.clientId} and ${info.clientId})`);
    }
    d.info = info; d.mac = mac; d.model = info.model || 'unknown'; d.lastSeen = Date.now();
    if (!d.name && info.site && info.site.name) d.suggestedName = info.site.name;
    this.dirty = true;
  }

  onTelemetry(d, text) {
    let t;
    try { t = JSON.parse(text); } catch { return; }
    if (!t || !Array.isArray(t.tags)) return;
    const base = `${this.prefix}/${d.id}`;
    for (const tag of t.tags) {
      if (!tag || typeof tag.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(tag.name)) continue;
      const v = tag.value === null || tag.value === undefined ? '' : String(tag.value);
      this.broker.publish(`${base}/tag/${tag.name}`, v, { retain: true, from: '$riot' });
      const q = String(tag.quality || 'GOOD');
      const key = d.id + '/' + tag.name;
      if (this.quality.get(key) !== q) { this.quality.set(key, q); this.broker.publish(`${base}/quality/${tag.name}`, q, { retain: true, from: '$riot' }); }
    }
    d.lastData = Date.now(); d.lastSeen = Date.now(); d.online = true;
    if (!t.part || t.part === t.parts) this.broker.publish(`${base}/meta/lastData`, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', { retain: true, from: '$riot' });
    this.dirty = true;
  }

  onOptMeta(d, text) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j.points !== 'object') return;
    d.opt = d.opt || { program: '', points: {} };
    d.opt.program = j.program || d.opt.program;
    Object.assign(d.opt.points, j.points);
    this.dirty = true;
  }

  onOpt(d, text) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j.v !== 'object') return;
    d.spt = d.spt || {};
    for (const [k, v] of Object.entries(j.v)) {
      if (!/^SPT\d+\.\d+$/.test(k)) continue;
      d.spt[k] = v;
      this.broker.publish(`${this.prefix}/${d.id}/opt/v/${k}`, v === null ? '' : String(v), { retain: true, from: '$riot' });
    }
    if (j.ts) d.sptTs = j.ts;
    d.lastSeen = Date.now(); this.dirty = true;
    // Soft points arrive as one message per SPT: assemble the panel status once the burst is in.
    clearTimeout(this.sptTimers?.[d.id]);
    this.sptTimers = this.sptTimers || {};
    this.sptTimers[d.id] = setTimeout(() => this.publishSptStatus(d), 400);
  }

  // Builds the same status object as the controller's /api/optimization from the OPT soft-point map
  // (SCADAPack OPT register layout, firmware opt/OptRegisters.cpp) and publishes it on opt7/1.
  publishSptStatus(d) {
    const v = (k) => { const x = d.spt[k]; return x === null || x === undefined ? null : Number(x); };
    if (v('SPT5.12') === null && v('SPT0.4') === null) return;   // nothing useful yet
    const status = sptToStatus(v);
    status.epoch = d.sptTs || Math.floor(Date.now() / 1000);
    status.source = 'soft points';
    this.broker.publish(`${this.prefix}/${d.id}/opt7/1`, JSON.stringify(status), { retain: true, from: '$riot' });
  }

  onOpt7(d, run, text) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j !== 'object' || !j.pv) return;
    const base = `${this.prefix}/${d.id}/opt7/${run}`;
    const pv = j.pv || {};
    const put = (k, v) => { if (v !== undefined && v !== null && v !== '') this.broker.publish(`${base}/${k}`, String(v), { retain: true, from: '$riot' }); };
    put('casing', pv.casing); put('tubing', pv.tubing); put('line', pv.line); put('flow', pv.flow);
    put('valve', j.valveKnown === false ? '' : j.valveOpen ? 1 : 0);
    d.opt7 = d.opt7 || {};
    const first = !d.opt7[run];
    d.opt7[run] = { mode: j.mode, modeName: j.modeName, running: !!j.running, at: Date.now() };
    d.lastSeen = Date.now(); this.dirty = true;
    // A well that starts sending optimizer data after approval: add the panels once (no manual edits lost yet).
    if (first && d.state === 'approved' && !d.optPanels) { d.optPanels = true; try { this.buildPage(d.id); this.buildOverview(); } catch { /* ignore */ } }
  }

  // ---------- actions ----------
  list() {
    return Object.values(this.db.devices).sort((a, b) => a.id.localeCompare(b.id)).map((d) => ({
      id: d.id, state: d.state, name: d.name || d.suggestedName || d.id, model: d.model, mac: d.mac, online: d.online,
      firstSeen: d.firstSeen, lastSeen: d.lastSeen, lastData: d.lastData || null, conflict: d.conflict || null,
      dashboard: d.state === 'approved' ? pages.pageId(d.id) : null,
      product: d.info?.product, firmware: d.info?.firmware, ip: d.info?.ip, site: d.info?.site, clientId: d.info?.clientId,
      io: d.info?.io, telemetry: d.info?.telemetry, tagCount: (d.info?.tags || []).length,
      tags: (d.info?.tags || []).map((t) => ({ name: t.name, label: t.label, units: t.units, type: t.type, source: t.source, writable: !!t.writable, telemetry: !!t.telemetry, range: t.range || null })),
      labels: d.labels || {}, opt: d.opt ? { program: d.opt.program, points: Object.keys(d.opt.points).length } : null,
      opt7: d.opt7 ? Object.keys(d.opt7).map(Number) : [],
    }));
  }

  approve(id, name) {
    const d = this.device(id);
    if (!d) throw new Error('unknown controller');
    if (!d.info) throw new Error('no description received from this controller yet');
    d.state = 'approved'; d.name = String(name || d.name || d.suggestedName || id).slice(0, 80); d.approvedAt = Date.now();
    delete d.conflict;
    this.dirty = true; this.flush();
    this.buildPage(id);
    this.buildOverview();
    this.log(`[riot] ${id} approved as "${d.name}"`);
    return d;
  }

  reject(id) {
    const d = this.device(id); if (!d) throw new Error('unknown controller');
    d.state = 'rejected'; this.dirty = true; this.flush();
    this.store.deleteDashboard(pages.pageId(id));
    this.buildOverview();
  }

  forget(id) {
    if (!this.db.devices[id]) throw new Error('unknown controller');
    delete this.db.devices[id]; this.dirty = true; this.flush();
    this.store.deleteDashboard(pages.pageId(id));
    this.buildOverview();
  }

  update(id, { name, labels }) {
    const d = this.device(id); if (!d) throw new Error('unknown controller');
    if (name !== undefined) d.name = String(name).slice(0, 80);
    if (labels && typeof labels === 'object') d.labels = cleanLabels(labels);
    this.dirty = true; this.flush();
    if (d.state === 'approved') this.buildOverview();
    return d;
  }

  profile(model) { return this.profiles[model] || { labels: {} }; }
  setProfile(model, { labels }) {
    this.profiles[model] = { ...(this.profiles[model] || {}), labels: cleanLabels(labels || {}), updated: Date.now() };
    this.saveProfiles();
    return this.profiles[model];
  }

  // Effective label of a Tag: this controller's override, the model profile, the controller's own label, its name.
  labelFor(d, tag) {
    return (d.labels && d.labels[tag.name]) || this.profile(d.model).labels[tag.name] || (tag.label && tag.label !== tag.name ? tag.label : tag.name);
  }

  buildPage(id) {
    const d = this.device(id);
    if (!d || d.state !== 'approved' || !d.info) throw new Error('controller is not approved');
    d.optPanels = pages.optRuns(d).length > 0;
    const dash = pages.wellPage(d, { prefix: this.prefix, labelFor: (t) => this.labelFor(d, t) });
    this.store.saveDashboard(pages.pageId(id), dash);
    return dash;
  }

  rebuildModel(model) {
    let n = 0;
    for (const d of Object.values(this.db.devices)) if (d.state === 'approved' && d.model === model) { this.buildPage(d.id); n++; }
    this.buildOverview();
    return n;
  }

  buildOverview() {
    const approved = Object.values(this.db.devices).filter((d) => d.state === 'approved').sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    const dash = pages.overviewPage(approved, { prefix: this.prefix, labelFor: (d, t) => this.labelFor(d, t) });
    this.store.saveDashboard(pages.OVERVIEW_ID, dash);
  }

  pendingCount() { return Object.values(this.db.devices).filter((d) => d.state === 'pending' && d.info).length; }
}

const OPT_MODES = ['Invalid', 'Time On vs. Time Off', 'Critical Flow vs. Time Off', 'Critical Flow vs. CSD < SP', 'Critical Flow vs. CSD > SP',
  'CSD < SP vs. Time Off', 'Critical Flow vs. Casing > SP', 'Critical Flow vs. Load Factor', 'Self Optimization Plunger'];
// OPT 7.02 (C port): 0 stopped, 1 running. OPT 5 port: 2 inactive, 3 running, 5 fast plunger, 6 valve conflict, 7 line high.
const PROGRAM_STATUS = { 0: 'Stopped', 1: 'Running', 2: 'Inactive', 3: 'Running', 5: 'Fast Plunger Shut In', 6: 'Valve Status Conflict', 7: 'Line Pressure High' };
// v(key) -> number|null for soft points "SPTn.p". Timers in the soft points count down (minutes remaining).
function sptToStatus(v) {
  const mode = v('SPT0.1'), ps = v('SPT1.1'), valve = v('SPT5.16'), depth = v('SPT0.9');
  const onSp = v('SPT1.9'), offSp = v('SPT1.11'), onLeft = v('SPT5.18'), offLeft = v('SPT5.20');
  const elapsed = (sp, left) => (sp === null || left === null ? null : Math.max(0, sp - left));
  const history = [];
  for (let i = 0; i < 10; i++) {
    const stamp = v(`SPT4.${2 + i}`), trip = v(`SPT4.${12 + i}`);
    if (trip > 0) history.push({ trip, stamp: stamp || 0, velocity: depth > 0 ? depth / trip : null });
  }
  const running = ps === 1 || ps === 3;
  return {
    ok: true, running, mode, modeName: OPT_MODES[mode] || OPT_MODES[0],
    programStatus: ps, banner: !running && (ps === 5 || ps === 7) ? 'SHUT IN' : undefined,
    modeStatusCode: v('SPT4.1'), modeStatusText: running ? undefined : PROGRAM_STATUS[ps],
    errorCode: v('SPT3.1') || 0, valveOpen: valve > 0, valveKnown: valve !== null, esd: v('SPT3.5') !== 0,
    pv: { casing: v('SPT5.12'), tubing: v('SPT5.13'), line: v('SPT5.14'), flow: v('SPT0.4'), criticalFlow: v('SPT3.12'), casingTubingDp: v('SPT3.9'), loadFactor: v('SPT3.16') },
    timers: { timeOn: elapsed(onSp, onLeft), timeOff: elapsed(offSp, offLeft), flowTime: v('SPT3.14'), shutInTime: v('SPT3.15') },
    plunger: { onTime: v('SPT3.18'), early: v('SPT3.19'), late: v('SPT3.20'), failed: v('SPT3.21'), avgVelocity: v('SPT5.17'), history,
      lastVelocity: v('SPT3.10'), lastDuration: v('SPT3.11') },
    config: { timeOnSp: onSp, timeOffSp: offSp, targetVelocity: v('SPT2.12'), wellDepth: depth, mode: v('SPT0.7') },
    run: 1,
  };
}

function cleanLabels(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
    const s = String(v ?? '').trim().slice(0, 60);
    if (s) out[k] = s;
  }
  return out;
}

module.exports = { Riots, macFromClientId, sptToStatus };
