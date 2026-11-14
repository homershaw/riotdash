'use strict';
// Demo dashboard seeded on first run. Pairs with tools/simulator.js.

let n = 0;
const w = (type, x, y, wd, ht, props) => ({ id: `demo${++n}`, type, x, y, w: wd, h: ht, props });
const pipe = (x, y, wd, ht, shape, topic, flowWhen = '') => w('pipe', x, y, wd, ht, { shape, topic, flowWhen, thickness: 10, color: '#64748b', flowColor: '#38bdf8', frame: false });

const dash = {
  name: 'Plant demo',
  settings: { grid: 10, width: 1480, height: 880, background: '' },
  widgets: [
    w('label', 20, 10, 700, 40, { text: 'Process plant — live demo', fontSize: 22, bold: true, color: '', frame: false }),
    w('label', 20, 60, 760, 470, { text: '', frame: true }), // mimic backdrop card

    w('label', 40, 120, 130, 24, { text: 'Supply ➜', fontSize: 12, bold: false, color: '#8492a6', frame: false }),
    pipe(40, 153, 132, 40, 'left-right', 'plant/inlet_valve/state', 'OPEN'),
    pipe(245, 153, 60, 40, 'left-right', 'plant/inlet_valve/state', 'OPEN'),
    pipe(350, 330, 40, 80, 'top-right', 'plant/flow/outlet'),
    pipe(385, 350, 90, 40, 'left-right', 'plant/flow/outlet'),
    pipe(550, 350, 75, 40, 'left-right', 'plant/flow/outlet'),
    pipe(695, 326, 70, 40, 'left-right', 'plant/flow/outlet'),
    w('label', 690, 368, 90, 22, { text: '➜ Process', fontSize: 12, bold: false, color: '#8492a6', frame: false }),

    w('valve', 160, 110, 100, 120, { label: 'XV-101 inlet', topic: 'plant/inlet_valve/state', commandTopic: 'plant/inlet_valve/set', style: 'gate', frame: false }),
    w('tank', 300, 80, 140, 260, { label: 'Tank T-1', topic: 'plant/tank1/level', units: '%', warnHigh: 85, alarmHigh: 95, warnLow: 15, frame: false }),
    w('valve', 465, 307, 100, 120, { label: 'XV-102 outlet', topic: 'plant/outlet_valve/state', commandTopic: 'plant/outlet_valve/set', style: 'ball', frame: false }),
    w('pump', 600, 300, 120, 130, { label: 'P-101', topic: 'plant/pump1/state', commandTopic: 'plant/pump1/set', style: 'pump', frame: false }),
    w('gauge', 540, 80, 210, 200, { label: 'Discharge pressure', topic: 'plant/pressure', units: 'bar', min: 0, max: 10, decimals: 2, warnHigh: 7, alarmHigh: 8.5, color: '#38bdf8', frame: true }),

    w('value', 40, 420, 140, 95, { label: 'Tank temp', topic: 'plant/tank1/temp', units: '°C', decimals: 1, fontSize: 30, warnHigh: 75, alarmHigh: 85, frame: true }),
    w('lamp', 190, 420, 110, 95, { label: 'High level', topic: 'plant/alarm/high_level', onColor: '#ef4444', offColor: '#334155', blink: true, frame: true }),
    w('status', 420, 440, 170, 75, { label: 'Level controller', topic: 'plant/mode', states: '0=Manual:#f59e0b\n1=Auto:#22c55e\n2=Fault:#ef4444', frame: true }),
    w('lamp', 600, 440, 150, 75, { label: 'Heater H-1', topic: 'plant/heater/state', onColor: '#f97316', offColor: '#334155', frame: true }),

    w('trend', 800, 60, 660, 280, { label: 'Tank level & temperature', series: 'plant/tank1/level||Level %|#38bdf8\nplant/tank1/temp||Temp °C|#f97316\nplant/setpoint/temp||Setpoint °C|#a3e635', window: 300, min: 0, max: 100, frame: true }),
    w('trend', 800, 360, 660, 220, { label: 'Flows (L/min)', series: 'plant/flow/inlet||Inlet\nplant/flow/outlet||Outlet', window: 300, units: 'L/min', frame: true }),

    w('switch', 20, 550, 180, 100, { label: 'Pump P-101', topic: 'plant/pump1/state', commandTopic: 'plant/pump1/set', onPayload: 'ON', offPayload: 'OFF', frame: true }),
    w('switch', 210, 550, 180, 100, { label: 'Auto level control', topic: 'plant/mode', commandTopic: 'plant/mode/set', onPayload: '1', offPayload: '0', onColor: '#0ea5e9', frame: true }),
    w('slider', 400, 550, 380, 100, { label: 'Temperature setpoint', topic: 'plant/setpoint/temp', commandTopic: 'plant/setpoint/temp/set', min: 20, max: 90, step: 1, units: '°C', frame: true }),

    w('gauge', 20, 670, 200, 190, { label: 'Room temperature', topic: 'sensors/room1', jsonPath: 'temp', units: '°C', min: 10, max: 35, decimals: 1, color: '#a78bfa', frame: true }),
    w('bar', 230, 670, 360, 80, { label: 'Room humidity', topic: 'sensors/room1', jsonPath: 'hum', units: '%', min: 0, max: 100, decimals: 0, color: '#2dd4bf', frame: true }),
    w('value', 230, 760, 175, 100, { label: 'Inlet flow', topic: 'plant/flow/inlet', units: 'L/min', decimals: 1, fontSize: 28, frame: true }),
    w('value', 415, 760, 175, 100, { label: 'Outlet flow', topic: 'plant/flow/outlet', units: 'L/min', decimals: 1, fontSize: 28, frame: true }),
    w('button', 600, 670, 180, 80, { label: 'Alarms', commandTopic: 'plant/alarm/reset', payload: '1', text: 'Acknowledge', color: '#ef4444', frame: true }),
    w('input', 600, 760, 180, 100, { label: 'Operator note', commandTopic: 'plant/notes', placeholder: 'Note…', frame: true }),

    w('log', 800, 600, 660, 260, { label: 'Message log (plant/#)', topic: 'plant/#', maxLines: 150, showTopic: true, frame: true }),
  ],
};

// Phone (list view) ordering: widget index -> position; small decorative labels hidden.
const phoneOrder = [0, 11, 10, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 19, 20, 24, 25, 26, 27, 28, 29, 30];
phoneOrder.forEach((idx, i) => { dash.widgets[idx].props.mobileOrder = i + 1; });
dash.widgets[2].props.mobileHide = true;
dash.widgets[9].props.mobileHide = true;

module.exports = dash;
