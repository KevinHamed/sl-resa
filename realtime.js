// GTFS-RT TripUpdates for SL (Trafiklab GTFS Regional Realtime), decoded by
// hand: only the handful of protobuf fields the planner needs.

// The key is visible to anyone reading this file; that was a deliberate
// choice (no backend). Fetches are cached so each device spends little quota.
const RT_KEY = 'e3ba064cd12b452a80414f54c2ef8e8d';
const RT_URL = `https://opendata.samtrafiken.se/gtfs-rt/sl/TripUpdates.pb?key=${RT_KEY}`;
const RT_MAX_AGE = 30 * 1000;

// ---------- minimal protobuf reader ----------

function* fields(buf, start = 0, end = buf.length) {
  let p = start;
  const varint = () => {
    let v = 0, mul = 1, b;
    do { b = buf[p++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return v;
  };
  while (p < end) {
    const tag = varint();
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) yield [field, varint()];
    else if (wire === 2) { const n = varint(); yield [field, null, p, p + n]; p += n; }
    else if (wire === 1) { yield [field, null]; p += 8; }
    else if (wire === 5) { yield [field, null]; p += 4; }
    else throw new Error(`protobuf wire type ${wire}`);
  }
}
const text = (buf, a, b) => new TextDecoder().decode(buf.subarray(a, b));
// int32 fields are varints of the two's complement; negatives arrive as 2^64 - n.
const int32 = (v) => (v > 2 ** 63 ? v - 2 ** 64 : v);

function stopEvent(buf, a, b) {
  const e = {};
  for (const [f, v] of fields(buf, a, b)) {
    if (f === 1) e.delay = int32(v);
    else if (f === 2) e.time = v;
  }
  return e;
}

// -> [{ tripId, startDate, canceled, stops: [{ seq, stopId, arr, dep, skipped }] }]
export function decodeTripUpdates(buf) {
  const out = [];
  let timestamp = 0;
  for (const [f, , a, b] of fields(buf)) {
    if (f === 1) { // header
      for (const [hf, hv] of fields(buf, a, b)) if (hf === 3) timestamp = hv;
      continue;
    }
    if (f !== 2) continue; // entity
    for (const [ef, , ea, eb] of fields(buf, a, b)) {
      if (ef !== 3) continue; // trip_update
      const u = { tripId: '', startDate: '', canceled: false, stops: [] };
      for (const [uf, , ua, ub] of fields(buf, ea, eb)) {
        if (uf === 1) { // TripDescriptor
          for (const [tf, tv, ta, tb] of fields(buf, ua, ub)) {
            if (tf === 1) u.tripId = text(buf, ta, tb);
            else if (tf === 3) u.startDate = text(buf, ta, tb);
            else if (tf === 4) u.canceled = tv === 3;
          }
        } else if (uf === 2) { // StopTimeUpdate
          const s = { seq: -1, stopId: '', arr: null, dep: null, skipped: false };
          for (const [sf, sv, sa, sb] of fields(buf, ua, ub)) {
            if (sf === 1) s.seq = sv;
            else if (sf === 4) s.stopId = text(buf, sa, sb);
            else if (sf === 2) s.arr = stopEvent(buf, sa, sb);
            else if (sf === 3) s.dep = stopEvent(buf, sa, sb);
            else if (sf === 5) s.skipped = sv === 1;
          }
          u.stops.push(s);
        }
      }
      if (u.tripId) out.push(u);
    }
  }
  return { timestamp, updates: out };
}

let cache = null; // { at, promise }
export function fetchTripUpdates() {
  if (cache && Date.now() - cache.at < RT_MAX_AGE) return cache.promise;
  const promise = fetch(RT_URL)
    .then((r) => { if (!r.ok) throw new Error(`Realtid: HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((b) => decodeTripUpdates(new Uint8Array(b)));
  cache = { at: Date.now(), promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}
