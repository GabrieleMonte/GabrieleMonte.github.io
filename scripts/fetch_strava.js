/**
 * Fetch recent Strava runs, bucket by month, write monthly JSON snapshots,
 * build index.json, and two tiny "recent 30d" files for the frontend.
 *
 * Usage (CI): node scripts/fetch_strava.js
 *
 * Requires repo secrets:
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   STRAVA_REFRESH_TOKEN
 *
 * Writes under: data/activities/
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(process.cwd(), 'data', 'activities');
const START_ISO = '2024-12-07T00:00:00Z';

// ---------- Helpers ----------
function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }
function readJSON(p){ return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, obj){
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function ymd(date){ return new Date(date).toISOString().slice(0,10); }
function ym(date){
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}
function uniqById(arr){
  const m = new Map();
  for (const a of arr) m.set(a.id, a);
  return Array.from(m.values());
}

// ---------- Token ----------
async function refreshAccessToken() {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    })
  });
  if (!r.ok) throw new Error(`Strava token refresh failed: ${r.status}`);
  const j = await r.json();
  return j.access_token;
}

// ---------- Fetch Activities ----------
async function fetchActivities(accessToken, afterUnix) {
  let page = 1, per_page = 200, out = [];
  while (true) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('per_page', per_page);
    url.searchParams.set('page', page);
    if (afterUnix) url.searchParams.set('after', afterUnix);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }});
    if (!r.ok) throw new Error(`Strava fetch failed: ${r.status}`);
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < per_page) break;
    page++;
  }
  return out;
}

// ---------- FIXED VERSION (correct timezone handling) ----------
function mapToSnapshotItems(activities){
  return activities
    .filter(a => a.type === 'Run')
    .map(a => {
      
      const distance_km = a.distance / 1000;

      // A) UTC timestamp from Strava
      const utcISO = a.start_date; // e.g. "2025-09-05T04:00:12Z"
      
      // B) Strava provides offset in seconds for the location/time
      const offsetSec = a.utc_offset ?? 0;    // e.g. -18000
      const offsetMs  = offsetSec * 1000;

      // C) Compute true local time at run location
      const localISO = new Date(new Date(utcISO).getTime() + offsetMs).toISOString();

      // Extract day + HH:MM in local time
      const date_local = localISO.slice(0,10);
      const time_hhmm  = localISO.slice(11,16);

      return {
        id: a.id,
        date: date_local,          
        start_iso: localISO,        // <-- true local time
        utc_start: utcISO,          // keep for debugging
        utc_offset: offsetSec,      // save exact offset
        start_latlng: a.start_latlng ?? null,

        distance_km,
        moving_time_s: a.moving_time,
        moving_time_min: a.moving_time / 60,
        avg_hr: a.average_heartrate ?? null,
        time_hhmm
      };
    });
}

// ---------- Merge ----------
function mergeById(oldArr, newArr){
  const merged = uniqById([...(oldArr||[]), ...newArr]);
  merged.sort((a,b)=> a.start_iso.localeCompare(b.start_iso));
  return merged;
}

// ---------- Build index ----------
function buildIndexFromMonths(files){
  const months = [];
  for (const f of files) {
    const arr = readJSON(f);
    const qualifying = arr.filter(a => a.distance_km >= 3.22);
    const miles = qualifying.reduce((s,a)=> s + (a.distance_km / 1.60934), 0);
    const days = new Set(qualifying.map(a => a.date)).size;
    months.push({ ym: path.basename(f, '.json'), days, miles: Number(miles.toFixed(2)) });
  }
  months.sort((a,b)=> a.ym.localeCompare(b.ym));
  return {
    start: START_ISO.slice(0,10),
    months,
    last_update: new Date().toISOString()
  };
}

// ---------- MAIN ----------
(async () => {
  ensureDir(OUT_DIR);

  let afterISO = START_ISO;
  const existing = fs.existsSync(OUT_DIR)
    ? fs.readdirSync(OUT_DIR).filter(n => /^\d{4}-\d{2}\.json$/.test(n)).map(n => path.join(OUT_DIR, n))
    : [];

  if (existing.length) {
    const latestFile = existing.sort().slice(-1)[0];
    const arr = readJSON(latestFile);
    if (arr.length) afterISO = arr[arr.length - 1].start_iso;
  }
  const afterUnix = Math.floor(new Date(afterISO).getTime() / 1000);

  const token = await refreshAccessToken();
  const acts = await fetchActivities(token, afterUnix);
  const items = mapToSnapshotItems(acts);

  // Bucket by month
  const buckets = new Map();
  for (const it of items) {
    const key = ym(it.start_iso);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }

  for (const [key, arr] of buckets) {
    const p = path.join(OUT_DIR, `${key}.json`);
    let old = [];
    if (fs.existsSync(p)) old = readJSON(p);
    const merged = mergeById(old, arr);
    writeJSON(p, merged);
  }

  const monthFiles = fs.existsSync(OUT_DIR)
    ? fs.readdirSync(OUT_DIR).filter(n => /^\d{4}-\d{2}\.json$/.test(n)).map(n => path.join(OUT_DIR, n))
    : [];
  writeJSON(path.join(OUT_DIR, 'index.json'), buildIndexFromMonths(monthFiles));

  // Recent 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const allRecent = [];
  for (const f of monthFiles) {
    const arr = readJSON(f);
    for (const it of arr) {
      if (new Date(it.start_iso) >= thirtyDaysAgo) allRecent.push(it);
    }
  }
  for (const it of items) {
    if (new Date(it.start_iso) >= thirtyDaysAgo) allRecent.push(it);
  }

  const recentUniq = uniqById(allRecent).sort((a,b)=> a.start_iso.localeCompare(b.start_iso));
  writeJSON(path.join(OUT_DIR, 'recent-30d.json'), recentUniq);

  const recentQual = recentUniq.filter(a => a.distance_km >= 3.22);
  const recentMiles = recentQual.reduce((s,a)=> s + (a.distance_km/1.60934), 0);
  const recentDays = new Set(recentQual.map(a=>a.date)).size;

  writeJSON(path.join(OUT_DIR, 'recent-30d-summary.json'), {
    days: recentDays,
    miles: Number(recentMiles.toFixed(2)),
    generated_at: new Date().toISOString()
  });

  console.log("Done.");
})().catch(e => { console.error(e); process.exit(1); });
