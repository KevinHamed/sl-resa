#!/usr/bin/env node
// Turns SL's GTFS Regional static feed into one compact timetable file per
// service day, which the browser loads to plan trips itself.
//
//   node tools/build-data.mjs <unzipped-gtfs-dir> <out-dir> [days=8]
//
// Output: <out-dir>/YYYYMMDD.bin.gz for yesterday .. today+days-1 (Stockholm),
// plus <out-dir>/index.json listing them. File layout is documented in
// router.js (loadDay), which is the only reader.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const [srcDir, outDir, daysArg] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error('usage: build-data.mjs <gtfs-dir> <out-dir> [days]');
  process.exit(1);
}
const DAYS = Number(daysArg || 8);
const DAY = 86400;
// Stops this close (straight line) count as one place: changing between them takes 0 min.
const TRANSFER_RADIUS_M = 300;
// Next-day trips starting before this are added to a day's file, so late
// evening searches can reach early-morning departures.
const NEXT_DAY_UNTIL = 8 * 3600;

// ---------- CSV ----------

function parseLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(srcDir, file), 'utf8'), crlfDelay: Infinity });
  let cols = null;
  for await (let line of rl) {
    if (!cols) {
      cols = Object.fromEntries(parseLine(line.replace(/^﻿/, '')).map((c, i) => [c, i]));
      continue;
    }
    if (line) fn(parseLine(line), cols);
  }
}

const toSec = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x; };

// ---------- dates (Stockholm) ----------

function stockholmToday() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p.replaceAll('-', '');
}
function addDays(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
const weekday = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay();

// ---------- load ----------

const services = new Map(); // service_id -> {days:[sun..sat], start, end, add:Set, remove:Set}
await eachRow('calendar.txt', (r, c) => {
  services.set(r[c.service_id], {
    days: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => r[c[d]] === '1'),
    start: r[c.start_date], end: r[c.end_date], add: new Set(), remove: new Set(),
  });
});
await eachRow('calendar_dates.txt', (r, c) => {
  let s = services.get(r[c.service_id]);
  if (!s) services.set(r[c.service_id], s = { days: Array(7).fill(false), start: '0', end: '0', add: new Set(), remove: new Set() });
  (r[c.exception_type] === '1' ? s.add : s.remove).add(r[c.date]);
});
function runsOn(serviceId, ymd) {
  const s = services.get(serviceId);
  if (!s) return false;
  if (s.add.has(ymd)) return true;
  if (s.remove.has(ymd)) return false;
  return ymd >= s.start && ymd <= s.end && s.days[weekday(ymd)];
}

const routes = new Map(); // route_id -> {short, type, desc}
await eachRow('routes.txt', (r, c) => {
  routes.set(r[c.route_id], { short: r[c.route_short_name] || r[c.route_long_name] || '', type: +r[c.route_type], desc: r[c.route_desc] || '' });
});

const stopsById = new Map(); // stop_id -> {name, lat, lon, parent, platform}
await eachRow('stops.txt', (r, c) => {
  const type = r[c.location_type] || '0';
  if (type !== '0') return;
  stopsById.set(r[c.stop_id], {
    id: r[c.stop_id], name: r[c.stop_name], lat: +r[c.stop_lat], lon: +r[c.stop_lon],
    parent: r[c.parent_station] || '', platform: r[c.platform_code] || '',
  });
});

const trips = new Map(); // trip_id -> {route, service, headsign, stops:[], arr:[], dep:[], flags:[]}
await eachRow('trips.txt', (r, c) => {
  trips.set(r[c.trip_id], { id: r[c.trip_id], route: r[c.route_id], service: r[c.service_id], headsign: r[c.trip_headsign] || '', stops: [], arr: [], dep: [], flags: [], stopHead: '' });
});
await eachRow('stop_times.txt', (r, c) => {
  const t = trips.get(r[c.trip_id]);
  if (!t || !stopsById.has(r[c.stop_id])) return;
  t.stops.push(r[c.stop_id]);
  t.arr.push(toSec(r[c.arrival_time] || r[c.departure_time]));
  t.dep.push(toSec(r[c.departure_time] || r[c.arrival_time]));
  // bit0: no boarding, bit1: no alighting (GTFS type 1 = not available)
  t.flags.push((r[c.pickup_type] === '1' ? 1 : 0) | (r[c.drop_off_type] === '1' ? 2 : 0));
  if (t.stops.length === 1) t.stopHead = r[c.stop_headsign] || '';
});
// stop_sequence order is the file order for SL; guard anyway.
for (const t of trips.values()) {
  if (t.stops.length < 2) { trips.delete(t.id); continue; }
  for (let i = 1; i < t.dep.length; i++) {
    if (t.arr[i] < t.dep[i - 1]) t.arr[i] = t.dep[i - 1];
    if (t.dep[i] < t.arr[i]) t.dep[i] = t.arr[i];
  }
}
console.log(`loaded ${trips.size} trips, ${stopsById.size} stops`);

// ---------- one day ----------

function buildDay(ymd) {
  // Trip instances relevant to day `ymd`, with times relative to its midnight.
  const inst = [];
  const prev = addDays(ymd, -1), next = addDays(ymd, 1);
  for (const t of trips.values()) {
    if (runsOn(t.service, ymd)) inst.push({ t, shift: 0, day: 0 });
    if (t.arr[t.arr.length - 1] >= DAY && runsOn(t.service, prev)) inst.push({ t, shift: -DAY, day: -1 });
    if (t.dep[0] < NEXT_DAY_UNTIL && runsOn(t.service, next)) inst.push({ t, shift: DAY, day: 1 });
  }

  // Stops actually served today.
  const stopIdx = new Map();
  const stopList = [];
  for (const { t } of inst) for (const s of t.stops) if (!stopIdx.has(s)) { stopIdx.set(s, stopList.length); stopList.push(stopsById.get(s)); }

  // Patterns: same route, stop sequence, flags and headsign. Trips sorted by
  // departure; a trip that would overtake another goes to a separate pattern
  // so every pattern stays first-in-first-out (needed for binary search).
  const groups = new Map();
  for (const x of inst) {
    const t = x.t;
    const head = t.headsign || t.stopHead || stopsById.get(t.stops[t.stops.length - 1]).name;
    const key = `${t.route}|${head}|${t.stops.join(',')}|${t.flags.join('')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { route: t.route, head, stops: t.stops, flags: t.flags, list: [] });
    g.list.push(x);
  }
  const patterns = [];
  for (const g of groups.values()) {
    g.list.sort((a, b) => a.t.dep[0] + a.shift - (b.t.dep[0] + b.shift));
    const subs = [];
    for (const x of g.list) {
      const fits = (sub) => {
        const y = sub[sub.length - 1];
        for (let i = 0; i < x.t.dep.length; i++) {
          if (x.t.dep[i] + x.shift < y.t.dep[i] + y.shift || x.t.arr[i] + x.shift < y.t.arr[i] + y.shift) return false;
        }
        return true;
      };
      const sub = subs.find(fits);
      if (sub) sub.push(x); else subs.push([x]);
    }
    for (const list of subs) patterns.push({ ...g, list });
  }

  // Zero-time transfers: every pair of stops within TRANSFER_RADIUS_M,
  // plus all stops under the same parent station.
  const cell = 0.005; // ~550 m lat, ~280 m lon at 59°N
  const grid = new Map();
  const ck = (la, lo) => `${Math.floor(la / cell)},${Math.floor(lo / cell)}`;
  stopList.forEach((s, i) => { const k = ck(s.lat, s.lon); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const R = 6371000, rad = Math.PI / 180;
  const dist = (a, b) => {
    const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad), y = (b.lat - a.lat) * rad;
    return Math.hypot(x, y) * R;
  };
  const byParent = new Map();
  stopList.forEach((s, i) => { if (s.parent) (byParent.get(s.parent) || byParent.set(s.parent, []).get(s.parent)).push(i); });
  const foot = stopList.map((s, i) => {
    const near = new Set();
    const gy = Math.floor(s.lat / cell), gx = Math.floor(s.lon / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
      for (const j of grid.get(`${gy + dy},${gx + dx}`) || []) if (j !== i && dist(s, stopList[j]) <= TRANSFER_RADIUS_M) near.add(j);
    }
    for (const j of byParent.get(s.parent) || []) if (j !== i) near.add(j);
    return [...near].sort((a, b) => a - b);
  });

  // ---------- serialise ----------
  const names = [], nameIdx = new Map();
  const str = (s) => { if (!nameIdx.has(s)) { nameIdx.set(s, names.length); names.push(s); } return nameIdx.get(s); };
  const routeIdx = new Map(), routeList = [];
  for (const p of patterns) if (!routeIdx.has(p.route)) { routeIdx.set(p.route, routeList.length); routeList.push(routes.get(p.route) || { short: '', type: 700, desc: '' }); }

  const nStops = stopList.length, nPat = patterns.length;
  const nTrips = patterns.reduce((n, p) => n + p.list.length, 0);
  const nPatStops = patterns.reduce((n, p) => n + p.stops.length, 0);
  const nEvents = patterns.reduce((n, p) => n + p.stops.length * p.list.length, 0);
  const nFoot = foot.reduce((n, f) => n + f.length, 0);

  const sec = {
    stopLat: new Float32Array(nStops), stopLon: new Float32Array(nStops),
    stopName: new Uint16Array(nStops), stopPlat: new Uint16Array(nStops),
    footStart: new Uint32Array(nStops + 1), footStops: new Uint16Array(nFoot),
    patRoute: new Uint16Array(nPat), patHead: new Uint16Array(nPat),
    patStopStart: new Uint32Array(nPat + 1), patStops: new Uint16Array(nPatStops), patFlags: new Uint8Array(nPatStops),
    patTripStart: new Uint32Array(nPat + 1),
    tripFirstDep: new Int32Array(nTrips), tripDay: new Int8Array(nTrips),
    // per trip, per stop: [arrival - previous departure, departure - arrival]
    tripDeltas: new Uint16Array(nEvents * 2),
  };
  const tripIds = [];
  stopList.forEach((s, i) => {
    sec.stopLat[i] = s.lat; sec.stopLon[i] = s.lon;
    sec.stopName[i] = str(s.name); sec.stopPlat[i] = str(s.platform);
  });
  let fo = 0;
  foot.forEach((f, i) => { sec.footStart[i] = fo; f.forEach((j) => { sec.footStops[fo++] = j; }); });
  sec.footStart[nStops] = fo;

  let ps = 0, tr = 0, ev = 0;
  patterns.forEach((p, pi) => {
    sec.patRoute[pi] = routeIdx.get(p.route);
    sec.patHead[pi] = str(p.head);
    sec.patStopStart[pi] = ps;
    p.stops.forEach((s, i) => { sec.patStops[ps] = stopIdx.get(s); sec.patFlags[ps] = p.flags[i]; ps++; });
    sec.patTripStart[pi] = tr;
    for (const { t, shift, day } of p.list) {
      sec.tripFirstDep[tr] = t.dep[0] + shift;
      sec.tripDay[tr] = day;
      tripIds.push(t.id);
      for (let i = 0; i < t.stops.length; i++) {
        sec.tripDeltas[ev++] = i === 0 ? 0 : Math.min(65535, t.arr[i] - t.dep[i - 1]);
        sec.tripDeltas[ev++] = Math.min(65535, t.dep[i] - t.arr[i]);
      }
      tr++;
    }
  });
  sec.patStopStart[nPat] = ps;
  sec.patTripStart[nPat] = tr;

  const meta = {
    format: 1, date: ymd, names, tripIds,
    routes: routeList.map((r) => [r.short, r.type, r.desc]),
    stopIds: stopList.map((s) => s.id),
    sections: Object.entries(sec).map(([name, a]) => [name, a.constructor.name, a.length]),
  };
  // [u32 json length][json][pad to 4][sections, each padded to 4]
  const json = Buffer.from(JSON.stringify(meta));
  const parts = [];
  const head = Buffer.alloc(4); head.writeUInt32LE(json.length);
  parts.push(head, json);
  let len = 4 + json.length;
  const pad = () => { const n = (4 - (len % 4)) % 4; if (n) { parts.push(Buffer.alloc(n)); len += n; } };
  pad();
  for (const a of Object.values(sec)) {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    parts.push(b); len += b.length; pad();
  }
  return { buf: Buffer.concat(parts), stats: { stops: nStops, patterns: nPat, trips: nTrips, events: nEvents, foot: nFoot } };
}

fs.mkdirSync(outDir, { recursive: true });
const today = stockholmToday();
const files = [];
for (let i = -1; i < DAYS; i++) {
  const ymd = addDays(today, i);
  const { buf, stats } = buildDay(ymd);
  if (!stats.trips) continue;
  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(path.join(outDir, `${ymd}.bin.gz`), gz);
  files.push(ymd);
  console.log(ymd, JSON.stringify(stats), `${(buf.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gz`);
}
let feedVersion = '';
try { feedVersion = fs.readFileSync(path.join(srcDir, 'feed_info.txt'), 'utf8').split('\n')[1].split(',').pop().trim(); } catch { /* optional */ }
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ built: new Date().toISOString(), feedVersion, days: files }));
