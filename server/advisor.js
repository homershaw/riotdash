'use strict';
// Advisor: plain checks on a well's plunger cycle records (server/cycles.js). No AI: each finding says what it saw,
// with numbers, the cycles behind it, the likely cause and what to consider. It never changes anything.
//
// "Now" is the newest record, so imported history is judged as of its own last day. Recent = the last 48 h;
// baseline = the 14 days before that.

const H = 3600, D = 86400;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (x) => Math.round(x * 100);
const r1 = (x) => Math.round(x * 10) / 10;
const arrived = (c) => c.arrival === 'ontime' || c.arrival === 'early' || c.arrival === 'late';
const judged = (c) => arrived(c) || c.arrival === 'failed';
const LINE_HIGH = [2010];   // OPT 7.02 mode status: line pressure high cycle

// least-squares slope of y over x
function slope(pts) {
  if (pts.length < 3) return 0;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let n = 0, d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  return d ? n / d : 0;
}

function gasPerDay(list, from, to) {
  const g = list.filter((c) => c.gas !== undefined);
  if (!g.length) return null;
  const days = Math.max(1 / 24, (to - from) / D);
  return g.reduce((a, c) => a + c.gas, 0) / days;
}

function evaluate(records, { now = Date.now() / 1000 } = {}) {
  const out = [];
  if (!records.length) return { asOf: null, findings: out, status: 'none' };
  const ref = records[records.length - 1].endTs || records[records.length - 1].openTs;
  const recent = records.filter((c) => c.openTs > ref - 2 * D);
  const base = records.filter((c) => c.openTs <= ref - 2 * D && c.openTs > ref - 16 * D);
  const span = (l) => (l.length ? (l[l.length - 1].openTs - l[0].openTs) / D : 0);
  const add = (f) => out.push({ severity: 'warn', ...f });
  const evidence = (list) => list.slice(-30).map((c) => c.openTs);

  // 0. No cycles lately (only for a well that is still reporting, i.e. its newest record is under a week old)
  if (now - ref < 7 * D && now - ref > 6 * H && records.length > 20) {
    add({ id: 'no-cycles', severity: 'alarm', title: 'No cycles recorded', detail: `The last cycle ended ${r1((now - ref) / H)} h ago. The well cycled ${r1(records.filter((c) => c.openTs > ref - D).length)} times in its last day of data.`,
      cause: 'Optimizer stopped, an ESD, a valve or communication problem, or the well loaded up and stays shut in.', action: 'Check the controller and the well.' });
  }

  // 1. Velocity against target (SPT2.12)
  const target = Number((recent.find((c) => c.sp && c.sp['SPT2.12']) || {}).sp?.['SPT2.12']) || null;
  const vRecent = recent.filter((c) => c.velocity > 0).map((c) => c.velocity);
  if (target && vRecent.length >= 8) {
    const v = median(vRecent), off = v / target - 1;
    if (off > 0.25) add({ id: 'fast', severity: off > 0.5 ? 'alarm' : 'warn', title: 'Plunger arriving too fast',
      detail: `Median velocity over the last 48 h is ${Math.round(v)} m/min, ${pct(off)} % above the ${Math.round(target)} m/min target (${vRecent.length} arrivals).`,
      cause: 'Shut-in longer than needed builds too much casing pressure; fast arrivals wear the plunger and lubricator.',
      action: 'Consider shortening the shut-in (lower Time Off or Min Shut-in) or lowering the load factor setpoint, in small steps.', cycles: evidence(recent.filter((c) => c.velocity > 0)) });
    else if (off < -0.25) add({ id: 'slow', title: 'Plunger arriving slowly',
      detail: `Median velocity over the last 48 h is ${Math.round(v)} m/min, ${pct(-off)} % below the ${Math.round(target)} m/min target (${vRecent.length} arrivals).`,
      cause: 'Not enough casing pressure for the liquid load: shut-in too short, or more liquid coming in.',
      action: 'Consider a longer shut-in (raise Time Off or Min Shut-in) or a higher load factor setpoint.', cycles: evidence(recent.filter((c) => c.velocity > 0)) });
  }

  // 2. Velocity creeping up over 7 days with the same setpoints → worn plunger or pad
  const week = records.filter((c) => c.openTs > ref - 7 * D && c.velocity > 0);
  if (week.length >= 30 && span(week) >= 5) {
    const spKey = (c) => JSON.stringify([c.sp?.['SPT1.11'], c.sp?.['SPT2.6'], c.sp?.['SPT2.7'], c.sp?.['SPT2.8'], c.mode]);
    const same = week.every((c) => spKey(c) === spKey(week[0]));
    // a longer shut-in or a lower line also speeds the plunger up: only a creep with both steady points to the plunger
    const half = (l, k) => [median(l.slice(0, l.length >> 1).map((c) => c[k]).filter((x) => x > 0)), median(l.slice(l.length >> 1).map((c) => c[k]).filter((x) => x > 0))];
    const [s1, s2] = half(week, 'shutInMin'), [l1, l2] = half(week, 'lineOpen');
    const steady = (!s1 || Math.abs(s2 / s1 - 1) < 0.1) && (!l1 || Math.abs(l2 / l1 - 1) < 0.1);
    const s = slope(week.map((c) => [(c.openTs - ref) / D, c.velocity])) / (median(week.map((c) => c.velocity)) || 1);
    const tripS = slope(week.filter((c) => c.tripMin > 0).map((c) => [(c.openTs - ref) / D, c.tripMin]));
    if (s > 0.025 && same && steady) add({ id: 'creep', title: 'Velocity creeping up',
      detail: `Velocity rose about ${pct(s)} % a day over the last 7 days (${week.length} arrivals) with no setpoint changes and steady shut-in and line pressure; trip time is ${tripS < 0 ? 'falling' : 'about steady'}.`,
      cause: 'A worn plunger or pad lets gas bypass it, so it travels faster with less liquid above it.',
      action: 'Inspect the plunger and compare its diameter to a new one. Replace it if worn.', cycles: evidence(week) });
  }

  // 3. Arrivals getting worse → liquid loading
  const jr = recent.filter(judged), jb = base.filter(judged);
  if (jr.length >= 10) {
    const badR = jr.filter((c) => c.arrival === 'late' || c.arrival === 'failed').length / jr.length;
    const failR = jr.filter((c) => c.arrival === 'failed').length / jr.length;
    const badB = jb.length >= 20 ? jb.filter((c) => c.arrival === 'late' || c.arrival === 'failed').length / jb.length : null;
    if (failR >= 0.1 || (badB !== null && badR - badB >= 0.15 && badR >= 0.25)) {
      add({ id: 'loading', severity: failR >= 0.2 ? 'alarm' : 'warn', title: 'Late and failed arrivals rising',
        detail: `In the last 48 h ${pct(badR)} % of cycles were late or failed (${pct(failR)} % failed)${badB !== null ? `, against ${pct(badB)} % in the 14 days before` : ''}.`,
        cause: 'Liquid loading: more liquid than the plunger can lift with the current shut-in and casing pressure.',
        action: 'Consider a longer shut-in or a higher load factor setpoint. If it continues, check for a stuck or worn plunger and for a change in water production.',
        cycles: evidence(jr.filter((c) => c.arrival === 'late' || c.arrival === 'failed')) });
    }
  }

  // 4. Casing not building during shut-in → tubing or packer leak (needs the previous cycle's casingEnd)
  const build = (list) => {
    const out2 = [];
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1], c = list[i];
      if (c.casingOpen !== undefined && p.casingEnd !== undefined && c.shutInMin > 0 && c.closeTs - p.endTs < 300) out2.push({ c, rate: (c.casingOpen - p.casingEnd) / c.shutInMin });
    }
    return out2;
  };
  const bAll = build(records.filter((c) => c.openTs > ref - 16 * D));
  const bR = bAll.filter((x) => x.c.openTs > ref - 2 * D), bB = bAll.filter((x) => x.c.openTs <= ref - 2 * D);
  if (bR.length >= 8 && bB.length >= 20) {
    const now2 = median(bR.map((x) => x.rate)), was = median(bB.map((x) => x.rate));
    if (was > 0 && now2 < was * 0.7) add({ id: 'casing-build', title: 'Casing pressure building slower',
      detail: `During shut-in, casing builds ${r1(now2)} kPa/min over the last 48 h, against ${r1(was)} kPa/min in the 14 days before (${pct(1 - now2 / was)} % slower).`,
      cause: 'Gas escaping from the casing: a tubing leak, a packer problem, or the casing valve left open to sales. Less often, lower reservoir inflow.',
      action: 'Check the casing valve position and look for a tubing leak (casing and tubing pressures tracking each other while shut in).', cycles: evidence(bR.map((x) => x.c)) });
  }

  // 5. Line pressure high
  const lhR = recent.filter((c) => LINE_HIGH.includes(Number(c.end))).length / (recent.length || 1);
  const lhB = base.length ? base.filter((c) => LINE_HIGH.includes(Number(c.end))).length / base.length : null;
  const lineR = median(recent.map((c) => c.lineOpen).filter((x) => x > 0)), lineB = median(base.map((c) => c.lineOpen).filter((x) => x > 0));
  const lineUp = lineR && lineB ? lineR / lineB - 1 : 0;
  if (recent.length >= 8 && ((lhR >= 0.2 && (lhB === null || lhR - lhB >= 0.1)) || lineUp >= 0.15)) {
    add({ id: 'line-high', title: 'Line pressure higher',
      detail: `${lineR && lineB ? `Line pressure at open is ${Math.round(lineR)} kPa over the last 48 h, against ${Math.round(lineB)} kPa before (${lineUp >= 0 ? '+' : ''}${pct(lineUp)} %). ` : ''}${pct(lhR)} % of cycles ended on line pressure high${lhB !== null ? ` (was ${pct(lhB)} %)` : ''}.`,
      cause: 'A gathering-system or downstream problem (compressor down, a restriction, a hydrate), not the well itself.',
      action: 'Check the sales line and compressor. Setpoint changes on the well will not fix this.', cycles: evidence(recent.filter((c) => LINE_HIGH.includes(Number(c.end)))) });
  }

  // 6. Production down against the well's own baseline (gas per day)
  if (recent.length >= 8 && base.length >= 40) {
    const gR = gasPerDay(recent, ref - 2 * D, ref), gB = gasPerDay(base, base[0].openTs, ref - 2 * D);
    if (gR !== null && gB > 0 && gR < gB * 0.85) {
      const causes = out.filter((f) => ['loading', 'casing-build', 'line-high', 'creep', 'slow', 'fast'].includes(f.id)).map((f) => f.title.toLowerCase());
      add({ id: 'gas-down', severity: gR < gB * 0.7 ? 'alarm' : 'warn', title: `Gas down ${pct(1 - gR / gB)} %`,
        detail: `${r1(gR)} E3m3/d over the last 48 h, against ${r1(gB)} E3m3/d over the 14 days before. Cycles per day: ${r1(recent.length / 2)} now, ${r1(base.length / Math.max(1, span(base)))} before.`,
        cause: causes.length ? `Likely tied to the other findings: ${causes.join(', ')}.` : 'No other finding explains it: check the flow measurement and the well\'s decline.',
        action: causes.length ? 'Deal with the findings above first.' : 'Compare with the meter and the well\'s expected decline.' });
    }
  }

  // Weak arrivals are often a symptom: point at the cause when one was found
  const root = out.find((f) => f.id === 'casing-build' || f.id === 'line-high');
  for (const f of out) if (root && (f.id === 'loading' || f.id === 'slow')) f.cause = `Probably a result of "${root.title.toLowerCase()}" (see that finding): less pressure to lift the plunger. Otherwise: ${f.cause.charAt(0).toLowerCase() + f.cause.slice(1)}`;
  // Most severe first; at the same severity, causes before their effects
  const sev = { alarm: 0, warn: 1, info: 2 }, order = ['no-cycles', 'casing-build', 'line-high', 'creep', 'fast', 'slow', 'loading', 'gas-down'];
  out.sort((a, b) => sev[a.severity] - sev[b.severity] || order.indexOf(a.id) - order.indexOf(b.id));
  return { asOf: ref, recentCycles: recent.length, status: out.length ? out[0].severity : 'ok', findings: out };
}

module.exports = { evaluate };
