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
const START_ISO = '2024-12-07T00:00:00Z'; // first day of the challenge

// --- Helpers ---
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

async function fetchActivities(accessToken, afterUnix) {
  // fetch in pages until exhaustion
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

function mapToSnapshotItems(activities){
  // Keep only qualifying runs for the challenge summary (>= 3.2 km & type "Run")
  return activities
    .filter(a => a.type === 'Run')
    .map(a => {
      const distance_km = a.distance / 1000;
      const start_iso = a.start_date; // already UTC ISO from Strava
      const d = new Date(start_iso);
      const time_hhmm = d.toISOString().slice(11,16); // HH:MM (UTC)
      return {
        id: a.id,
        date: ymd(start_iso),
        start_iso,
        distance_km,
        moving_time_min: a.moving_time / 60,
        avg_hr: a.average_heartrate ?? null,
        time_hhmm
      };
    });
}

function mergeById(oldArr, newArr){
  const merged = uniqById([...(oldArr||[]), ...newArr]);
  merged.sort((a,b)=> a.start_iso.localeCompare(b.start_iso));
  return merged;
}

function buildIndexFromMonths(files){
  const months = [];
  for (const f of files) {
    const ymKey = path.basename(f, '.json');
    const arr = readJSON(f);
    // Only count days/miles where distance >= 3.2 km (2 miles)
    const qualifying = arr.filter(a => a.distance_km >= 3.2);
    const miles = qualifying.reduce((s,a)=> s + (a.distance_km / 1.60934), 0);
    const days = new Set(qualifying.map(a => a.date)).size;
    months.push({ ym: ymKey, days, miles: Number(miles.toFixed(2)) });
  }
  months.sort((a,b)=> a.ym.localeCompare(b.ym));
  const index = {
    start: START_ISO.slice(0,10),
    months,
    last_update: new Date().toISOString()
  };
  return index;
}

(async () => {
  ensureDir(OUT_DIR);

  // Determine "after" cutoff = max of last-saved timestamp or START_ISO
  // We scan existing monthly files to find the max timestamp already saved, so we only pull deltas.
  let afterISO = START_ISO;
  const existing = fs.readdirSync(OUT_DIR)
    .filter(n => /^\d{4}-\d{2}\.json$/.test(n))
    .map(n => path.join(OUT_DIR, n));

  if (existing.length) {
    // read last file for its final item
    const latestFile = existing.sort().slice(-1)[0];
    const arr = readJSON(latestFile);
    if (arr.length) afterISO = arr[arr.length - 1].start_iso;
  }
  const afterUnix = Math.floor(new Date(afterISO).getTime() / 1000);

  const token = await refreshAccessToken();
  const acts = await fetchActivities(token, afterUnix);
  const items = mapToSnapshotItems(acts);

  // Bucket by month and merge with existing monthly files
  const buckets = new Map(); // ym -> items[]
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

  // (Re)build index.json from all monthly files
  const monthFiles = fs.readdirSync(OUT_DIR)
    .filter(n => /^\d{4}-\d{2}\.json$/.test(n))
    .map(n => path.join(OUT_DIR, n));
  const index = buildIndexFromMonths(monthFiles);
  writeJSON(path.join(OUT_DIR, 'index.json'), index);

  // Build "recent 30d" static files (for fast frontend freshness)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  // Gather all recent items from monthly files + any freshly fetched
  const allRecent = [];
  for (const f of monthFiles) {
    const arr = readJSON(f);
    for (const it of arr) {
      if (new Date(it.start_iso) >= thirtyDaysAgo) allRecent.push(it);
    }
  }
  // include current batch too (in case of same-month write)
  for (const it of items) {
    if (new Date(it.start_iso) >= thirtyDaysAgo) allRecent.push(it);
  }

  const recentUniq = uniqById(allRecent).sort((a,b)=> a.start_iso.localeCompare(b.start_iso));
  writeJSON(path.join(OUT_DIR, 'recent-30d.json'), recentUniq);

  const recentQual = recentUniq.filter(a => a.distance_km >= 3.2);
  const recentMiles = recentQual.reduce((s,a)=> s + (a.distance_km/1.60934), 0);
  const recentDays  = new Set(recentQual.map(a=>a.date)).size;
  writeJSON(path.join(OUT_DIR, 'recent-30d-summary.json'), {
    days: recentDays,
    miles: Number(recentMiles.toFixed(2)),
    generated_at: new Date().toISOString()
  });

  console.log(`Wrote ${monthFiles.length} month files, index.json, and recent-30d files.`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
