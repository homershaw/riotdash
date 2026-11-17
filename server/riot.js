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
//
// Writing (OPT soft points): riotdash publishes opt/set {"id","SPTn.p":v…} (opt/run2/set for run 2) and waits for the
// controller's opt/ack {"id","ok","written","error"}. The controller only listens while writes are turned on at the
// controller itself, so no ack means writes are off there (or it is offline). Every write is logged to riot-writes.jsonl.

const fs = require('fs');
const path = require('path');
const pages = require('./riot-pages');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function atomicWrite(file, data) { const t = file + '.tmp'; fs.writeFileSync(t, data); fs.renameSync(t, file); }
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
const macFromClientId = (cid) => { const m = /([0-9A-Fa-f]{12})$/.exec(cid || ''); return m ? m[1].toUpperCase().match(/../g).join(':') : null; };

class Riots {
  constructor({ broker, store, config, cycles = null, log = console.log }) {
    this.broker = broker; this.store = store; this.config = config; this.log = log; this.cycles = cycles;
    this.file = path.join(store.dir, 'riots.json');
    this.profilesFile = path.join(store.dir, 'riot-profiles.json');
    this.db = readJson(this.file, { devices: {} });
    this.profiles = readJson(this.profilesFile, {});
    this.quality = new Map(); // `${id}/${tag}` -> last quality published
    this.writesFile = path.join(store.dir, 'riot-writes.jsonl');
    this.pendingWrites = new Map(); // write id -> { resolve, timer }
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
    if (rest.startsWith('tag/') || rest.startsWith('quality/') || rest.startsWith('meta/') || /^opt\/(run\d+\/)?v\//.test(rest) || /^opt7\/\d+\/./.test(rest)) return;
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
    // Optimizer run 1: opt/SPTn, opt/meta/SPTn. A second run: opt/run2/SPTn, opt/run2/meta/SPTn.
    const cyc = /^opt\/(?:run(\d+)\/)?cycle$/.exec(rest);
    if (cyc) { if (this.cycles) this.cycles.onMessage(id, Number(cyc[1] || 1), text); return; }
    const ack = /^opt\/(?:run(\d+)\/)?ack$/.exec(rest);
    if (ack) return this.onAck(d, text);
    const om = /^opt\/(?:run(\d+)\/)?(meta\/)?SPT\d+$/.exec(rest);
    if (om) { const run = Number(om[1] || 1); return om[2] ? this.onOptMeta(d, text, run) : this.onOpt(d, text, run); }
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

  onOptMeta(d, text, run = 1) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j.points !== 'object') return;
    const key = run === 1 ? 'opt' : `opt${run}`;
    d[key] = d[key] || { program: '', points: {} };
    d[key].program = j.program || d[key].program;
    Object.assign(d[key].points, j.points);
    this.dirty = true;
  }

  onOpt(d, text, run = 1) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j.v !== 'object') return;
    const key = run === 1 ? 'spt' : `spt${run}`;
    const vbase = `${this.prefix}/${d.id}/opt/${run === 1 ? '' : `run${run}/`}v`;
    d[key] = d[key] || {};
    for (const [k, v] of Object.entries(j.v)) {
      if (!/^SPT\d+\.\d+$/.test(k)) continue;
      d[key][k] = v;
      this.broker.publish(`${vbase}/${k}`, v === null ? '' : String(v), { retain: true, from: '$riot' });
    }
    if (j.ts) d[key + 'Ts'] = j.ts;
    d.lastSeen = Date.now(); this.dirty = true;
    // Soft points arrive as one message per SPT: assemble the panel status once the burst is in.
    this.sptTimers = this.sptTimers || {};
    const tk = `${d.id}/${run}`;
    clearTimeout(this.sptTimers[tk]);
    this.sptTimers[tk] = setTimeout(() => this.publishSptStatus(d, run), 400);
  }

  // Builds the same status object as the controller's /api/optimization from the OPT soft-point map
  // (SCADAPack OPT register layout, firmware opt/OptRegisters.cpp) and publishes it on opt7/1.
  publishSptStatus(d, run = 1) {
    const spt = (run === 1 ? d.spt : d[`spt${run}`]) || {};
    const v = (k) => { const x = spt[k]; return x === null || x === undefined ? null : Number(x); };
    if (v('SPT5.12') === null && v('SPT0.4') === null) return;   // nothing useful yet
    // Valve feedback comes from the M31 rack: if all its DO Tags are not GOOD (M31 offline), the valve state is unknown,
    // as the controller's own page shows, even though the valve soft point reads 0.
    const doQ = run !== 1 ? [] : [1, 2, 3, 4].map((n) => this.quality.get(`${d.id}/M31.DO${n}`)).filter(Boolean);
    const status = sptToStatus(v, { valveUnknown: doQ.length > 0 && doQ.every((q) => q !== 'GOOD') });
    status.epoch = (run === 1 ? d.sptTs : d[`spt${run}Ts`]) || Math.floor(Date.now() / 1000);
    status.source = 'soft points';
    status.run = run;
    this.broker.publish(`${this.prefix}/${d.id}/opt7/${run}`, JSON.stringify(status), { retain: true, from: '$riot' });
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
    // (A second run appearing later adds its panels the same way.)
    if (first && d.state === 'approved' && (Number(d.optPanels) || 0) < pages.optRuns(d).length) { try { this.buildPage(d.id); this.buildOverview(); } catch { /* ignore */ } }
  }

  // ---------- writing soft points ----------
  onAck(d, text) {
    let j; try { j = JSON.parse(text); } catch { return; }
    const p = j && this.pendingWrites.get(String(j.id));
    if (!p) return;   // not ours (another client, or already timed out)
    clearTimeout(p.timer); this.pendingWrites.delete(String(j.id)); p.resolve(j);
  }

  // Names, units and R/W flags of one optimizer run: the controller's opt/meta when it sent one, else the OPT 7.02 table.
  optPoints(d, run = 1) {
    const meta = ((run === 1 ? d.opt : d[`opt${run}`]) || {}).points || {};
    const spt = (run === 1 ? d.spt : d[`spt${run}`]) || {};
    const mode8 = Number(spt['SPT0.1']) === 8;
    const out = {};
    for (const k of new Set([...Object.keys(spt), ...Object.keys(meta)])) {
      const def = OPT_POINTS[k] ? { name: OPT_POINTS[k][0], units: OPT_POINTS[k][1], rw: 1 } : { name: k, units: '', rw: 0 };
      if (mode8 && OPT_POINTS_MODE8[k]) Object.assign(def, { name: OPT_POINTS_MODE8[k][0], units: OPT_POINTS_MODE8[k][1] });
      out[k] = { ...def, ...(meta[k] || {}), value: spt[k] === undefined ? null : spt[k] };
    }
    return out;
  }

  optState(id, run = 1) {
    const d = this.device(id);
    if (!d) throw Object.assign(new Error('unknown controller'), { status: 404 });
    return {
      id, run, name: d.name || d.suggestedName || id, online: d.online, program: ((run === 1 ? d.opt : d[`opt${run}`]) || {}).program || '',
      points: this.optPoints(d, run), updated: (run === 1 ? d.sptTs : d[`spt${run}Ts`]) || null, writes: this.recentWrites(id, 15),
    };
  }

  // values: {"SPTn.p": number}. Resolves with the controller's ack, or {ok:false, timeout:true}.
  async writeOpt(id, run, values, who, timeoutMs = 15000) {
    const d = this.device(id);
    if (!d || d.state !== 'approved') throw Object.assign(new Error('controller is not approved'), { status: 400 });
    run = Number(run) || 1;
    if (!values || typeof values !== 'object' || !Object.keys(values).length) throw Object.assign(new Error('nothing to write'), { status: 400 });
    const pts = this.optPoints(d, run), clean = {};
    for (const [k, v] of Object.entries(values)) {
      if (!/^SPT\d+\.\d+$/.test(k)) throw Object.assign(new Error(`Unknown key ${k} (use SPTn.p)`), { status: 400 });
      const n = Number(v);
      if (v === '' || v === null || !Number.isFinite(n)) throw Object.assign(new Error(`${k} must be a number`), { status: 400 });
      if (pts[k] && !Number(pts[k].rw)) throw Object.assign(new Error(`${k} (${pts[k].name}) is read-only`), { status: 400 });
      clean[k] = n;
    }
    const wid = 'rd-' + crypto.randomBytes(4).toString('hex');
    const topic = `${this.prefix}/${id}/opt/${run === 1 ? '' : `run${run}/`}set`;
    const before = Object.fromEntries(Object.keys(clean).map((k) => [k, pts[k] ? pts[k].value : null]));
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pendingWrites.delete(wid); resolve({ id: wid, ok: false, timeout: true,
        error: d.online === false ? 'The controller is offline' : 'No reply from the controller. Writes from MQTT are probably turned off on it (they can only be turned on from the controller\'s own MQTT page).' }); }, timeoutMs);
      this.pendingWrites.set(wid, { resolve, timer });
      this.broker.publish(topic, JSON.stringify({ id: wid, ...clean }), { from: '$riot' });
    });
    const entry = { at: Date.now(), id, run, wid, by: who || 'unknown', values: clean, before, ok: !!result.ok, error: result.error || '', timeout: !!result.timeout };
    try { fs.appendFileSync(this.writesFile, JSON.stringify(entry) + '\n'); } catch (e) { this.log('[riot] write log: ' + e.message); }
    this.log(`[riot] write ${id} run ${run} by ${entry.by}: ${JSON.stringify(clean)} → ${entry.ok ? 'ok' : 'rejected: ' + entry.error}`);
    return result;
  }

  recentWrites(id, n = 50) {
    let lines = [];
    try { lines = fs.readFileSync(this.writesFile, 'utf8').trim().split('\n'); } catch { return []; }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) { try { const e = JSON.parse(lines[i]); if (!id || e.id === id) out.push(e); } catch { /* skip */ } }
    return out;
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

  // ---------- page templates: one controller's page, saved as the layout for every controller of its model ----------
  // Topics and links are stored with placeholders ({id}, {page}, {name}) and filled in for each controller.
  saveTemplate(id) {
    const d = this.device(id);
    if (!d || d.state !== 'approved' || !d.model) throw new Error('only an approved controller with a model can be a template');
    const dash = this.store.getDashboard(pages.pageId(id));
    if (!dash) throw new Error('this controller has no page');
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let json = JSON.stringify({ settings: dash.settings || {}, widgets: dash.widgets || [] });
    json = json.replace(new RegExp(esc(`${this.prefix}/${id}/`), 'g'), `${this.prefix}/{id}/`)
      .replace(new RegExp(`"${esc(pages.pageId(id))}"`, 'g'), '"{page}"');
    const name = d.name || id;
    const t = JSON.parse(json);
    for (const w of t.widgets) for (const [k, v] of Object.entries(w.props || {})) if (v === name) w.props[k] = '{name}';
    const p = this.profiles[d.model] = this.profiles[d.model] || { labels: {} };
    p.template = { from: id, fromName: name, at: Date.now(), widgets: t.widgets.length, page: t };
    this.saveProfiles();
    this.log(`[riot] page of ${id} saved as the template for ${d.model}`);
    return p.template;
  }
  removeTemplate(model) {
    const p = this.profiles[model];
    if (p && p.template) { delete p.template; this.saveProfiles(); }
  }
  fromTemplate(d, tpl) {
    const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
    const json = JSON.stringify(tpl.page).split('{id}').join(esc(d.id)).split('"{page}"').join(JSON.stringify(pages.pageId(d.id))).split('"{name}"').join(JSON.stringify(d.name || d.id));
    const t = JSON.parse(json);
    return { name: d.name || d.id, settings: { ...t.settings, generated: { by: 'riot', controller: d.id, model: d.model, template: tpl.from, at: Date.now() } }, widgets: t.widgets };
  }

  buildPage(id) {
    const d = this.device(id);
    if (!d || d.state !== 'approved' || !d.info) throw new Error('controller is not approved');
    d.optPanels = pages.optRuns(d).length;   // number of optimizer runs with panels
    const tpl = d.model && this.profiles[d.model] && this.profiles[d.model].template;
    const dash = tpl ? this.fromTemplate(d, tpl) : pages.wellPage(d, { prefix: this.prefix, labelFor: (t) => this.labelFor(d, t) });
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

// R/W soft points of OPT 7.02 (RIoT OPT Soft Points over MQTT): [name, units]
const OPT_POINTS = {
  'SPT0.2': ['Critical Flow Override Enable', ''], 'SPT0.3': ['Start Position', ''], 'SPT0.5': ['Pre-Flow Enable', ''], 'SPT0.6': ['Program Start/Stop', ''],
  'SPT0.7': ['Mode Selection', ''], 'SPT0.8': ['Water Fraction', ''], 'SPT0.9': ['Well Depth', 'm'], 'SPT0.10': ['Tubing Diameter', 'mm'],
  'SPT1.2': ['Critical Flow Manual SP', 'E3m3/d'], 'SPT1.3': ['Casing Tubing Diff Pressure SP', 'kPa'], 'SPT1.4': ['Casing Pressure Off Cycle SP (Mode 6)', 'kPa'],
  'SPT1.6': ['Line Pressure Dead Band SP', 'kPa'], 'SPT1.8': ['Max Line Pressure SP', 'kPa'], 'SPT1.9': ['Time On SP', 'min'], 'SPT1.10': ['Time On Bypass SP', 'min'],
  'SPT1.11': ['Time Off SP', 'min'], 'SPT1.12': ['Time Off Bypass SP', 'min'], 'SPT1.15': ['Pre-Flow On Time SP', 'min'], 'SPT1.16': ['Pre-Flow Off Time SP', 'min'],
  'SPT1.17': ['Max Number of Failed Arrivals', ''], 'SPT1.18': ['Early Arrival Time SP', 'min'], 'SPT1.19': ['Late Arrival Time SP', 'min'],
  'SPT1.20': ['Max Number of Early Arrivals', ''], 'SPT1.21': ['Max Number of Late Arrivals', ''],
  'SPT2.3': ['Max Flow Time SP', 'min'], 'SPT2.4': ['Min Flow Time SP', 'min'], 'SPT2.6': ['Max Shut-in Time SP', 'min'], 'SPT2.7': ['Min Shut-in Time SP', 'min'],
  'SPT2.8': ['Load Factor SP', '%'], 'SPT2.9': ['Casing Tubing Diff Pressure Inc.', 'kPa'], 'SPT2.10': ['Casing Tubing Diff Pressure Dec.', 'kPa'],
  'SPT2.11': ['Casing Tubing Diff Pressure Limit', 'kPa'], 'SPT2.12': ['Target Velocity SP', 'm/min'],
};
const OPT_POINTS_MODE8 = { 'SPT1.9': ['Post Plunger Shut-in Time SP', 'min'], 'SPT2.4': ['PPST Correction Factor Cp', ''], 'SPT2.5': ['PPST Correction Factor Ci', ''], 'SPT2.8': ['PPST Correction Ramp', 'min'] };
OPT_POINTS['SPT2.5'] = ['PPST Correction Factor Ci', ''];
const OPT_MODES = ['Invalid', 'Time On vs. Time Off', 'Critical Flow vs. Time Off', 'Critical Flow vs. CSD < SP', 'Critical Flow vs. CSD > SP',
  'CSD < SP vs. Time Off', 'Critical Flow vs. Casing > SP', 'Critical Flow vs. Load Factor', 'Self Optimization Plunger'];
// OPT 7.02 (C port): 0 stopped, 1 running. OPT 5 port: 2 inactive, 3 running, 5 fast plunger, 6 valve conflict, 7 line high.
const PROGRAM_STATUS = { 0: 'Stopped', 1: 'Running', 2: 'Inactive', 3: 'Running', 5: 'Fast Plunger Shut In', 6: 'Valve Status Conflict', 7: 'Line Pressure High' };
// Program error codes shared by OPT 7.02 (opt7/opt.h) and the OPT 5 port (WellOptCore.h).
// Program version register: 70200 → "7.02.00", 5 → "5.00"
const version = (x) => (!(x > 0) ? undefined : x >= 10000 ? `${Math.floor(x / 10000)}.${String(Math.floor(x / 100) % 100).padStart(2, '0')}.${String(x % 100).padStart(2, '0')}` : Number(x).toFixed(2));
const OPT_ERRORS = { 111: 'Line pressure input', 112: 'Line pressure high', 114: 'Fast plunger shut-in', 115: 'Stopped by operator',
  116: 'ESD input invalid', 117: 'Well ESD', 118: 'Start position', 119: 'Mode 8 needs a plunger', 120: 'Flow run' };
// v(key) -> number|null for soft points "SPTn.p". Timers in the soft points count down (minutes remaining).
// The timer that is counting in the current cycle (OPT 7.02 opt2mode.c): pre-flow on/off (2005/2006), the bypass timers in
// bypass cycles, otherwise time on or time off. Soft points hold the time remaining; the panel shows elapsed against the setpoint.
function activeTimer(v) {
  const msc = v('SPT4.1');
  const pick = (label, spKey, leftKey, kind) => {
    const sp = v(spKey), left = v(leftKey);
    return sp > 0 && left !== null ? { label, sp, elapsed: Math.max(0, sp - left), kind } : null;
  };
  if (msc === 2005) return pick('Pre-flow on', 'SPT1.15', 'SPT3.6', 'preflow');
  if (msc === 2006) return pick('Pre-flow off', 'SPT1.16', 'SPT3.7', 'preflow');
  if ([2002, 2007, 2008, 2011, 2013, 2015].includes(msc)) return pick('Time on bypass', 'SPT1.10', 'SPT5.19', 'on') || pick('Time on', 'SPT1.9', 'SPT5.18', 'on');
  if ([2004, 2014].includes(msc)) return pick('Time off bypass', 'SPT1.12', 'SPT5.21', 'off') || pick('Time off', 'SPT1.11', 'SPT5.20', 'off');
  return null;   // time on / time off: chosen by the panel from the valve
}

function sptToStatus(v, { valveUnknown = false } = {}) {
  const mode = v('SPT0.1'), ps = v('SPT1.1'), valve = v('SPT5.16'), depth = v('SPT0.9');
  const onSp = v('SPT1.9'), offSp = v('SPT1.11'), onLeft = v('SPT5.18'), offLeft = v('SPT5.20');
  const elapsed = (sp, left) => (sp === null || left === null ? null : Math.max(0, sp - left));
  const history = [];
  for (let i = 0; i < 10; i++) {
    const stamp = v(`SPT4.${2 + i}`), trip = v(`SPT4.${12 + i}`);
    if (trip > 0) history.push({ trip, stamp: stamp || 0, velocity: depth > 0 ? depth / trip : null });
  }
  const running = ps === 1 || ps === 3;
  const err = v('SPT3.1') || 0;
  return {
    ok: true, running, mode, modeName: OPT_MODES[mode] || OPT_MODES[0],
    programStatus: ps, banner: !running && (ps === 5 || ps === 7) ? 'SHUT IN' : undefined,
    modeStatusCode: v('SPT4.1'), modeStatusText: running ? undefined : PROGRAM_STATUS[ps],
    // ESD: judged from the program error (117 ESD, 116 invalid ESD input). The ESD soft point reads 0 when no ESD input is bound,
    // while the optimizer itself treats an unbound ESD as permissive.
    errorCode: err, errorText: OPT_ERRORS[err], valveOpen: valve > 0, valveKnown: valve !== null && !valveUnknown, valveNote: valveUnknown ? 'M31 offline' : undefined,
    esd: !(err === 116 || err === 117), programVersion: version(v('SPT3.0')),
    // Critical flow: the manual setpoint when the override is on (SPT0.2), else the calculated value, as /api/optimization does.
    pv: { casing: v('SPT5.12'), tubing: v('SPT5.13'), line: v('SPT5.14'), flow: v('SPT0.4'), criticalFlow: v('SPT0.2') ? v('SPT1.2') : v('SPT3.12'),
      criticalFlowManual: !!v('SPT0.2'), casingTubingDp: v('SPT3.9'), loadFactor: v('SPT3.16') },
    timers: { timeOn: elapsed(onSp, onLeft), timeOff: elapsed(offSp, offLeft), flowTime: v('SPT3.14'), shutInTime: v('SPT3.15'),
      preFlowOn: elapsed(v('SPT1.15'), v('SPT3.6')), preFlowOff: elapsed(v('SPT1.16'), v('SPT3.7')),
      timeOnBypass: elapsed(v('SPT1.10'), v('SPT5.19')), timeOffBypass: elapsed(v('SPT1.12'), v('SPT5.21')) },
    activeTimer: activeTimer(v),
    plunger: { onTime: v('SPT3.18'), early: v('SPT3.19'), late: v('SPT3.20'), failed: v('SPT3.21'), avgVelocity: v('SPT5.17'), history,
      lastVelocity: v('SPT3.10'), lastDuration: v('SPT3.11') },
    config: { timeOnSp: onSp, timeOffSp: offSp, preFlowOnSp: v('SPT1.15'), preFlowOffSp: v('SPT1.16'), timeOnBypassSp: v('SPT1.10'), timeOffBypassSp: v('SPT1.12'), targetVelocity: v('SPT2.12'), wellDepth: depth, mode: v('SPT0.7') },
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

module.exports = { Riots, macFromClientId, sptToStatus, OPT_MODES };
