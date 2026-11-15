# Plunger cycles

![Cycles page](img/cycles.png)

Every plunger cycle becomes one record: when the valve closed and opened, when (and whether) the plunger arrived, the pressures, the gas produced and the setpoints in effect. riotdash keeps the records per well in `data/cycles/<well>.jsonl`. They are the base for the cycle history now, and for the Advisor and AI tuning that come next.

The **Cycles** page shows, per well and for 7 days to a year:
- cycles per day, gas per day, on-time and failed arrival rates, average velocity
- gas per day, and cycles per day split by arrival result (hover a day for its numbers)
- a table by day and the most recent cycles

## Where records come from

**Controllers** publish one record when a cycle ends (the valve closes after flowing):

| Topic | Retained |
|---|---|
| `riot/<id>/opt/cycle` | no |
| `riot/<id>/opt/run2/cycle` | no (optimizer run 2) |

Only approved or waiting controllers are recorded. A record sent twice (same run and `seq`) is kept once, so a controller can safely re-send unsent records after a reconnect.

**History from other wells** loads from a CSV, one row per cycle, using the same field names plus `well`:
- on the Cycles page: **Import CSV…**
- or on the server: `node server/index.js import-cycles cycles.csv [well name]`

Rows already imported (same well and open time) are skipped, so importing a file twice is safe. Rows with errors are skipped and listed.

```csv
well,openTs,shutInMin,flowMin,arrival,tripMin,velocity,casingOpen,tubingOpen,lineOpen,gas,mode,SPT1.11,SPT2.12
BRAZEAU 4-12,2026-10-01 06:30,30,50,ontime,9,222,1310,1180,640,2.08,2,30,200
BRAZEAU 4-12,2026-10-01 07:50,30,22,late,16.5,121,1220,1150,655,0.71,2,30,200
```

Required: `well`, `openTs`, `shutInMin` or `closeTs`, `flowMin` or `endTs`. Times are epoch seconds or `YYYY-MM-DD hh:mm` (UTC unless followed by an offset such as `-06:00`). `well` is a controller id (`FED0`) or any name.

## Record fields

Times are epoch seconds (UTC), pressures kPa, gas E3m3, durations minutes, velocity m/min.

| Field | Meaning |
|---|---|
| `v`, `seq`, `run`, `mode` | format (1), cycle counter, optimizer run, mode during the cycle |
| `closeTs`, `openTs`, `arriveTs`, `endTs` | valve closed (shut-in start), opened, plunger arrived (0 = didn't), closed again |
| `arrival` | `ontime`, `early`, `late`, `failed` or `none` (no plunger sensor) |
| `shutInMin`, `tripMin`, `afterflowMin`, `flowMin` | durations; worked out from the times when missing |
| `velocity` | well depth / trip time; worked out from `sp` SPT0.9 when missing |
| `casingOpen`, `tubingOpen`, `lineOpen`, `loadFactorOpen` | just before the valve opened |
| `casingArrive`, `tubingArrive` | at arrival |
| `casingEnd`, `tubingEnd`, `lineEnd`, `lineMax` | when the valve closed; highest line pressure in the cycle |
| `gas`, `flowAvg` | gas during the flow period; average rate while open (gas is worked out from it when missing) |
| `end`, `error` | why the valve closed (mode status code, or `stopped`, `esd`, `restart`); program error at close |
| `sp` | the R/W soft points in effect when the valve opened, `{"SPTn.p": value}` |

## Storage and size

One line per cycle, about 400 bytes: a well cycling 20 times a day uses about 3 MB a year. Each well's file is read into memory when its page is opened. That comfortably covers hundreds of wells over several years.
