// Trip planner over SL's own timetable (GTFS), run in the browser.
//
// Rules (on purpose, unlike SL's planner):
// - Changing between stops within ~300 m takes 0 minutes. You judge yourself
//   whether a tight change is realistic.
// - Walking from the start address to the first stop, and from the last stop
//   to the destination, uses normal walking speed, up to 1 km.
//
// Search is RAPTOR (round-based: round k = k rides), see Delling et al. 2012.
// All times are seconds after midnight of the timetable's service day.

export const WALK_SPEED = 5 / 3.6; // m/s, ~5 km/h
export const WALK_DETOUR = 1.2;    // streets are longer than the straight line
export const WALK_MAX_M = 1000;    // straight-line limit for first/last walk
const MAX_RIDES = 5;
// As few changes as possible: an extra change must save at least this much time.
export const CHANGE_PENALTY = 10 * 60;
const INF = 0x7fffffff;

// ---------- loading ----------

// File: [u32 json length][json meta][pad 4][typed arrays in meta.sections order, each padded to 4].
export function parseDay(buffer) {
  const view = new DataView(buffer);
  const jsonLen = view.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, jsonLen)));
  let off = 4 + jsonLen;
  off += (4 - (off % 4)) % 4;
  const tt = { date: meta.date, names: meta.names, routes: meta.routes, stopIds: meta.stopIds, tripIds: meta.tripIds };
  const ctors = { Float32Array, Uint16Array, Uint32Array, Int32Array, Uint8Array, Int8Array };
  for (const [name, type, len] of meta.sections) {
    const C = ctors[type];
    tt[name] = new C(buffer, off, len);
    off += len * C.BYTES_PER_ELEMENT;
    off += (4 - (off % 4)) % 4;
  }
  return index(tt);
}

function index(tt) {
  const nStops = tt.stopLat.length, nPat = tt.patRoute.length, nTrips = tt.tripFirstDep.length;
  tt.nStops = nStops; tt.nPat = nPat; tt.nTrips = nTrips;

  // Absolute times per (trip, stop) and where each trip's row starts.
  tt.tripPattern = new Uint32Array(nTrips);
  tt.tripRow = new Uint32Array(nTrips);
  let nEvents = 0;
  for (let p = 0; p < nPat; p++) {
    const len = tt.patStopStart[p + 1] - tt.patStopStart[p];
    for (let t = tt.patTripStart[p]; t < tt.patTripStart[p + 1]; t++) {
      tt.tripPattern[t] = p; tt.tripRow[t] = nEvents; nEvents += len;
    }
  }
  tt.schedArr = new Int32Array(nEvents);
  tt.schedDep = new Int32Array(nEvents);
  for (let t = 0; t < nTrips; t++) {
    const row = tt.tripRow[t], p = tt.tripPattern[t];
    const len = tt.patStopStart[p + 1] - tt.patStopStart[p];
    // tripFirstDep is the departure from the first stop; its arrival is earlier by the dwell.
    let time = tt.tripFirstDep[t] - tt.tripDeltas[2 * row + 1];
    for (let i = 0; i < len; i++) {
      if (i > 0) time += tt.tripDeltas[2 * (row + i)];
      tt.schedArr[row + i] = time;
      time += tt.tripDeltas[2 * (row + i) + 1];
      tt.schedDep[row + i] = time;
    }
  }
  tt.arr = tt.schedArr.slice();
  tt.dep = tt.schedDep.slice();
  tt.realtime = new Uint8Array(nEvents);   // 1 = time from realtime
  tt.skipped = new Uint8Array(nEvents);    // stop skipped today (realtime)
  tt.canceled = new Uint8Array(nTrips);
  tt.patFifo = new Uint8Array(nPat).fill(1);

  // Patterns serving each stop, with the stop's position in the pattern.
  const count = new Uint32Array(nStops + 1);
  for (let i = 0; i < tt.patStops.length; i++) count[tt.patStops[i] + 1]++;
  for (let s = 0; s < nStops; s++) count[s + 1] += count[s];
  tt.stopPatStart = count.slice();
  tt.stopPats = new Uint32Array(tt.patStops.length);
  tt.stopPatPos = new Uint16Array(tt.patStops.length);
  const fill = count.slice();
  for (let p = 0; p < nPat; p++) {
    for (let i = tt.patStopStart[p]; i < tt.patStopStart[p + 1]; i++) {
      const s = tt.patStops[i];
      tt.stopPats[fill[s]] = p; tt.stopPatPos[fill[s]] = i - tt.patStopStart[p]; fill[s]++;
    }
  }

  tt.tripsById = new Map();
  tt.tripIds.forEach((id, t) => { const l = tt.tripsById.get(id); if (l) l.push(t); else tt.tripsById.set(id, [t]); });

  // Search workspace, reused between runs.
  const R = MAX_RIDES + 1;
  tt.ws = {
    board: new Int32Array(R * nStops),  // best time you can board at stop, after k rides
    ride: new Int32Array(R * nStops),   // arrival at stop by a vehicle, ride k
    parTrip: new Int32Array(R * nStops),
    parBoardPos: new Int16Array(R * nStops),
    parAlightPos: new Int16Array(R * nStops),
    parFoot: new Int32Array(R * nStops), // stop you alighted at before changing here (round k)
    bestRide: new Int32Array(nStops),
    egress: new Int32Array(nStops),
    marked: new Uint8Array(nStops),
    patQ: new Int32Array(nPat),
    forbid: new Int32Array(nStops), // stamp: stops the previous vehicle still reaches
    stamp: 0,
  };
  return tt;
}

// ---------- geometry & names ----------

export function distM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad), y = (lat2 - lat1) * rad;
  return Math.hypot(x, y) * 6371000;
}
export const walkSecs = (m) => Math.round((m * WALK_DETOUR) / WALK_SPEED);

// Stops within walking range of a point: [{ stop, m, secs }]
export function stopsNear(tt, lat, lon, maxM = WALK_MAX_M) {
  const out = [];
  for (let s = 0; s < tt.nStops; s++) {
    if (Math.abs(tt.stopLat[s] - lat) > 0.01 || Math.abs(tt.stopLon[s] - lon) > 0.02) continue;
    const m = distM(lat, lon, tt.stopLat[s], tt.stopLon[s]);
    if (m <= maxM) out.push({ stop: s, m: Math.round(m), secs: walkSecs(m) });
  }
  return out;
}

export const stopName = (tt, s) => tt.names[tt.stopName[s]];
export const stopPlatform = (tt, s) => tt.names[tt.stopPlat[s]];

// ---------- realtime ----------

// midnightSec: Unix seconds of the service day's 00:00 (Stockholm).
export function applyRealtime(tt, updates, midnightSec) {
  tt.arr.set(tt.schedArr); tt.dep.set(tt.schedDep);
  tt.realtime.fill(0); tt.skipped.fill(0); tt.canceled.fill(0);
  const touched = new Set();
  const dayOf = (ymd) => {
    if (!ymd) return 0;
    const d = (Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) -
      Date.UTC(+tt.date.slice(0, 4), +tt.date.slice(4, 6) - 1, +tt.date.slice(6, 8))) / 864e5;
    return d;
  };
  for (const u of updates) {
    const cands = tt.tripsById.get(u.tripId);
    if (!cands) continue;
    const day = dayOf(u.startDate);
    const t = cands.find((x) => tt.tripDay[x] === day);
    if (t === undefined) continue;
    if (u.canceled) { tt.canceled[t] = 1; continue; }
    const p = tt.tripPattern[t], row = tt.tripRow[t];
    const ps = tt.patStopStart[p], len = tt.patStopStart[p + 1] - ps;
    let pos = 0, delay = null;
    const at = (e, sched) => (e?.time ? e.time - midnightSec : e?.delay != null ? sched + e.delay : null);
    for (const su of u.stops) {
      let i = pos;
      while (i < len && tt.stopIds[tt.patStops[ps + i]] !== su.stopId) i++;
      if (i === len) continue;
      // stops between the previous update and this one keep the previous delay
      if (delay !== null) for (let j = pos; j < i; j++) shift(row + j, delay);
      const e = row + i;
      if (su.skipped) { tt.skipped[e] = 1; pos = i + 1; continue; }
      const a = at(su.arr, tt.schedArr[e]), d = at(su.dep, tt.schedDep[e]);
      if (a !== null) tt.arr[e] = a;
      if (d !== null) tt.dep[e] = d; else if (a !== null) tt.dep[e] = Math.max(tt.schedDep[e] + (a - tt.schedArr[e]), a);
      if (a === null && d !== null) tt.arr[e] = Math.min(tt.schedArr[e] + (d - tt.schedDep[e]), d);
      tt.realtime[e] = 1;
      delay = tt.dep[e] - tt.schedDep[e];
      pos = i + 1;
    }
    if (delay !== null) for (let j = pos; j < len; j++) shift(row + j, delay);
    // keep each trip's times non-decreasing
    for (let i = 1; i < len; i++) {
      if (tt.arr[row + i] < tt.dep[row + i - 1]) tt.arr[row + i] = tt.dep[row + i - 1];
      if (tt.dep[row + i] < tt.arr[row + i]) tt.dep[row + i] = tt.arr[row + i];
    }
    touched.add(p);
  }
  function shift(e, delay) { tt.arr[e] = tt.schedArr[e] + delay; tt.dep[e] = tt.schedDep[e] + delay; tt.realtime[e] = 1; }

  // Delays can make a trip overtake another; such patterns use linear trip search.
  tt.patFifo.fill(1);
  for (const p of touched) {
    const ps = tt.patStopStart[p], len = tt.patStopStart[p + 1] - ps;
    outer: for (let t = tt.patTripStart[p] + 1; t < tt.patTripStart[p + 1]; t++) {
      for (let i = 0; i < len; i++) {
        if (tt.dep[tt.tripRow[t] + i] < tt.dep[tt.tripRow[t - 1] + i]) { tt.patFifo[p] = 0; break outer; }
      }
    }
  }
}

// ---------- RAPTOR ----------

// Earliest trip of pattern p you can board at position i at or after `time`.
function earliestTrip(tt, p, i, time, excludeTrip) {
  const t0 = tt.patTripStart[p], t1 = tt.patTripStart[p + 1];
  const ok = (t) => !tt.canceled[t] && !tt.skipped[tt.tripRow[t] + i] && t !== excludeTrip;
  if (tt.patFifo[p]) {
    let lo = t0, hi = t1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tt.dep[tt.tripRow[mid] + i] < time) lo = mid + 1; else hi = mid;
    }
    for (let t = lo; t < t1; t++) if (ok(t)) return t;
    return -1;
  }
  let best = -1, bestDep = INF;
  for (let t = t0; t < t1; t++) {
    const d = tt.dep[tt.tripRow[t] + i];
    if (d >= time && d < bestDep && ok(t)) { best = t; bestDep = d; }
  }
  return best;
}

// sources: [{ stop, time }] where you can board (walk from start included).
// targets: [{ stop, secs }] walk from stop to the destination.
// prevLeg: { trip, toPos } you just got off, when the sources are a change point.
// Returns the best journey for each number of rides, fastest last:
// [{ arrival, rides, legs: [{ trip, fromPos, toPos }], lastStop }]
//
// A change is not allowed if the vehicle you got off still goes to the stop
// where the next one drops you (or within 0-min change distance of it): you
// would just be hopping onto a vehicle ahead of yours on the same way.
export function raptor(tt, sources, targets, { maxRides = MAX_RIDES, horizon = INF, excludeTrip = -1, excludeRouteFirst = -1, prevLeg = null } = {}) {
  const ws = tt.ws;
  const { board, ride, parTrip, parBoardPos, parAlightPos, parFoot, bestRide, egress, marked, patQ, forbid } = ws;
  // Stamp the stops trip T still serves after position ap, plus their 0-min neighbours.
  const stampAfter = (T, ap) => {
    const id = ++ws.stamp;
    const pp = tt.tripPattern[T], pps = tt.patStopStart[pp], plen = tt.patStopStart[pp + 1] - pps;
    for (let j = ap + 1; j < plen; j++) {
      const y = tt.patStops[pps + j];
      forbid[y] = id;
      for (let f = tt.footStart[y]; f < tt.footStart[y + 1]; f++) forbid[tt.footStops[f]] = id;
    }
    return id;
  };
  const n = tt.nStops;
  board.fill(INF, 0, (maxRides + 1) * n);
  ride.fill(INF, 0, (maxRides + 1) * n);
  bestRide.fill(INF);
  egress.fill(-1);
  for (const { stop, secs } of targets) if (egress[stop] < 0 || secs < egress[stop]) egress[stop] = secs;

  let markedList = [];
  for (const { stop, time } of sources) {
    if (time < board[stop]) board[stop] = time;
    if (!marked[stop]) { marked[stop] = 1; markedList.push(stop); }
  }
  let bestDest = horizon;
  const results = [];

  for (let k = 1; k <= maxRides && markedList.length; k++) {
    const prev = (k - 1) * n, cur = k * n;
    // Patterns to scan, from the earliest marked stop on each.
    const pats = [];
    for (const s of markedList) {
      marked[s] = 0;
      for (let j = tt.stopPatStart[s]; j < tt.stopPatStart[s + 1]; j++) {
        const p = tt.stopPats[j], pos = tt.stopPatPos[j];
        if (patQ[p] === 0) { pats.push(p); patQ[p] = pos + 1; } else if (pos + 1 < patQ[p]) patQ[p] = pos + 1;
      }
    }
    const improved = [];
    for (const p of pats) {
      const startPos = patQ[p] - 1;
      patQ[p] = 0;
      if (k === 1 && tt.patRoute[p] === excludeRouteFirst) continue;
      const ps = tt.patStopStart[p], len = tt.patStopStart[p + 1] - ps;
      let t = -1, row = 0, boardPos = -1, stamp = 0;
      for (let i = startPos; i < len; i++) {
        const s = tt.patStops[ps + i], flags = tt.patFlags[ps + i];
        if (t >= 0 && !(flags & 2) && !tt.skipped[row + i] && (stamp === 0 || forbid[s] !== stamp)) {
          const a = tt.arr[row + i];
          if (a < bestRide[s] && a < bestDest) {
            if (ride[cur + s] === INF) improved.push(s);
            ride[cur + s] = a; bestRide[s] = a;
            parTrip[cur + s] = t; parBoardPos[cur + s] = boardPos; parAlightPos[cur + s] = i;
          }
        }
        const b = board[prev + s];
        if (b !== INF && !(flags & 1) && (t < 0 || b <= tt.dep[row + i])) {
          const nt = earliestTrip(tt, p, i, b, excludeTrip);
          if (nt >= 0 && (t < 0 || tt.dep[tt.tripRow[nt] + i] < tt.dep[row + i] || nt === t)) {
            if (nt !== t) {
              t = nt; row = tt.tripRow[t]; boardPos = i;
              // The vehicle you came with, if any.
              let T = -1, ap = 0;
              if (k > 1) { const a = parFoot[prev + s]; T = parTrip[prev + a]; ap = parAlightPos[prev + a]; } else if (prevLeg) { T = prevLeg.trip; ap = prevLeg.toPos; }
              stamp = T >= 0 ? stampAfter(T, ap) : 0;
            }
          }
        }
      }
    }
    // Destination check, then 0-minute changes to nearby stops.
    let bestThisRound = null;
    for (const s of improved) {
      if (egress[s] >= 0) {
        const d = ride[cur + s] + egress[s];
        if (d < bestDest) { bestDest = d; bestThisRound = s; }
      }
    }
    if (bestThisRound !== null) results.push({ arrival: bestDest, rides: k, lastStop: bestThisRound, legs: legsOf(tt, k, bestThisRound) });

    markedList = [];
    const relax = (to, time, from) => {
      if (time < board[cur + to]) {
        board[cur + to] = time; parFoot[cur + to] = from;
        if (!marked[to]) { marked[to] = 1; markedList.push(to); }
      }
    };
    for (const s of improved) {
      const a = ride[cur + s];
      if (a >= bestDest) continue;
      relax(s, a, s);
      for (let j = tt.footStart[s]; j < tt.footStart[s + 1]; j++) relax(tt.footStops[j], a, s);
    }
  }
  for (const s of markedList) marked[s] = 0;
  return results;
}

function legsOf(tt, k, stop) {
  const { parTrip, parBoardPos, parAlightPos, parFoot } = tt.ws;
  const n = tt.nStops, legs = [];
  let s = stop;
  for (; k > 0; k--) {
    const c = k * n + s;
    const trip = parTrip[c], fromPos = parBoardPos[c], toPos = parAlightPos[c];
    legs.unshift({ trip, fromPos, toPos });
    if (k > 1) {
      const p = tt.tripPattern[trip];
      const boardStop = tt.patStops[tt.patStopStart[p] + fromPos];
      s = parFoot[(k - 1) * n + boardStop];
    }
  }
  return legs;
}

// ---------- journeys ----------

// Arrival with each change counted as CHANGE_PENALTY extra.
const cost = (arrive, changes) => arrive + changes * CHANGE_PENALTY;
const fewestChanges = (res) => res.reduce((a, b) => (cost(b.arrival, b.rides) < cost(a.arrival, a.rides) ? b : a));

// Option o makes option j pointless: o starts no earlier, has no more changes,
// and arrives no later (each change o saves counts as CHANGE_PENALTY).
function beats(oStart, o, jStart, j) {
  if (o.changes > j.changes || oStart < jStart) return false;
  const slack = (j.changes - o.changes) * CHANGE_PENALTY;
  if (o.arrive > j.arrive + slack) return false;
  return oStart > jStart || o.arrive < j.arrive + slack || o.changes < j.changes;
}

const legStop = (tt, leg, pos) => tt.patStops[tt.patStopStart[tt.tripPattern[leg.trip]] + pos];

// Full journey with times, for display.
function describe(tt, legs, startWalk, endWalks) {
  const out = legs.map((l) => {
    const p = tt.tripPattern[l.trip], row = tt.tripRow[l.trip];
    const [short, type, desc] = tt.routes[tt.patRoute[p]];
    const from = legStop(tt, l, l.fromPos), to = legStop(tt, l, l.toPos);
    return {
      trip: l.trip, route: tt.patRoute[p], fromPos: l.fromPos, toPos: l.toPos,
      line: short, type, desc, headsign: tt.names[tt.patHead[p]], tripId: tt.tripIds[l.trip],
      from, to, fromName: stopName(tt, from), toName: stopName(tt, to),
      fromPlatform: stopPlatform(tt, from), toPlatform: stopPlatform(tt, to),
      dep: tt.dep[row + l.fromPos], schedDep: tt.schedDep[row + l.fromPos], depRt: !!tt.realtime[row + l.fromPos],
      arr: tt.arr[row + l.toPos], schedArr: tt.schedArr[row + l.toPos], arrRt: !!tt.realtime[row + l.toPos],
      stops: l.toPos - l.fromPos,
    };
  });
  const first = out[0], last = out[out.length - 1];
  const walkIn = startWalk.get(first.from);
  const walkOut = endWalks.get(last.to);
  return {
    legs: out,
    walkIn, walkOut,
    leave: first.dep - walkIn.secs,
    arrive: last.arr + walkOut.secs,
    changes: out.length - 1,
  };
}

// Plan from a point to a point. Each result group is one departure from the
// start; its `options` are the next few ways to continue from the first change
// (0 min change, then the following departures), each a complete journey.
//
//   const p = planner(tt, from, to);
//   const groups = p.next(startSec, 6);  // call again to get later departures
export function planner(tt, from, to) {
  const near = stopsNear(tt, from.lat, from.lon);
  const ends = stopsNear(tt, to.lat, to.lon);
  if (!near.length) throw new Error('Ingen hållplats inom 1 km från start.');
  if (!ends.length) throw new Error('Ingen hållplats inom 1 km från målet.');
  const startWalk = new Map(near.map((x) => [x.stop, x]));
  const endWalks = new Map(ends.map((x) => [x.stop, x]));
  const targets = ends.map((x) => ({ stop: x.stop, secs: x.secs }));
  const seen = new Set();
  let cursor = null;

  function options(main) {
    const first = main.legs[0];
    if (main.legs.length === 1) return [{ ...main, wait: null }];
    const transferStop = first.to, a1 = first.arr;
    const srcStops = [transferStop];
    for (let j = tt.footStart[transferStop]; j < tt.footStart[transferStop + 1]; j++) srcStops.push(tt.footStops[j]);
    const firstLeg = [{ trip: first.trip, fromPos: first.fromPos, toPos: first.toPos }];
    const found = [];
    let t = a1;
    for (let tries = 0; tries < 8 && found.length < 4; tries++) {
      const res = raptor(tt, srcStops.map((stop) => ({ stop, time: t })), targets, {
        maxRides: MAX_RIDES - 1, horizon: a1 + 4 * 3600, excludeTrip: first.trip, excludeRouteFirst: first.route,
        prevLeg: { trip: first.trip, toPos: first.toPos },
      });
      if (!res.length) break;
      const best = fewestChanges(res);
      const j = describe(tt, [...firstLeg, ...best.legs], startWalk, endWalks);
      found.push(j);
      t = j.legs[1].dep + 1;
    }
    // Keep only continuations no later one beats.
    const pareto = found.filter((j) => !found.some((o) => o !== j && beats(o.legs[1].dep, o, j.legs[1].dep, j)));
    return pareto.slice(0, 3).map((j) => ({ ...j, wait: j.legs[1].dep - a1 }));
  }

  // Pointless departure: a later one gets there as early (allowing for changes saved).
  function dominated(g, all) {
    for (const o of all.values()) if (o !== g && beats(o.leave, o.main, g.leave, g.main)) return true;
    return false;
  }

  return {
    startWalk, endWalks,
    // Next `want` departure groups from time `start` (or where the last call stopped).
    next(start, want = 6, maxSpanSec = 4 * 3600) {
      let t = cursor ?? start;
      const limit = t + maxSpanSec;
      const byTrip = new Map(); // first vehicle -> group; the same vehicle may be reachable from several stops
      const live = () => [...byTrip.values()].filter((g) => !dominated(g, byTrip)).length;
      while (live() < want && t < limit) {
        const res = raptor(tt, near.map((x) => ({ stop: x.stop, time: t + x.secs })), targets, { horizon: t + maxSpanSec });
        if (!res.length) { t += 15 * 60; continue; }
        let nextT = INF;
        for (const r of res) {
          const j = describe(tt, r.legs, startWalk, endWalks);
          nextT = Math.min(nextT, j.leave + 1);
          const key = j.legs[0].trip;
          if (seen.has(key)) continue;
          const old = byTrip.get(key);
          if (!old || j.leave > old.leave || (j.leave === old.leave && cost(j.arrive, j.changes) < cost(old.main.arrive, old.main.changes))) {
            byTrip.set(key, { key, leave: j.leave, main: j });
          }
        }
        t = Math.max(nextT, t + 1);
      }
      cursor = t;
      const groups = [...byTrip.values()].filter((g) => !dominated(g, byTrip));
      groups.forEach((g) => seen.add(g.key));
      groups.sort((a, b) => a.leave - b.leave || a.main.arrive - b.main.arrive);
      for (const g of groups) g.options = options(g.main);
      return groups;
    },
  };
}
