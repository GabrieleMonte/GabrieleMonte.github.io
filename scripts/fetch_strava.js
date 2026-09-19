/**
 * Fetch Strava runs, bucket them by month in CENTRAL TIME, write monthly JSON
 * snapshots, build index.json, and two tiny "recent 30d" files for the frontend.
 *
 * Usage (CI):  node scripts/fetch_strava.js
 *       full:  FULL_REFRESH=1 node scripts/fetch_strava.js   (or --full)
 *
 * Requires: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
 * Writes under: data/activities/
 *
 * Design notes (why this is not an "only fetch what's new" script any more):
 *   - Strava activities are often uploaded late and out of order (a watch that
 *     syncs days later, a manual upload, an edit). A forward-only cursor based on
 *     the newest activity already saved makes any straggler permanently invisible.
 *     Instead every run re-reads a rolling WINDOW_DAYS window and reconciles it,
 *     so late uploads, edits and deletions all heal themselves.
 *   - The window is wide enough that it does not matter whether Strava's `after`
 *     filter compares against start_date or start_date_local.
 */
import fs from 'fs';
import path from 'path';

const OUT_DIR    = path.join(process.cwd(), 'data', 'activities');
const START_ISO  = '2024-12-07T00:00:00Z';
const START_DAY  = START_ISO.slice(0, 10);

// The clock that decides which calendar day a run counts for. Everything stored
// in the snapshots (date, start_iso, time_hhmm, month bucket) is this clock,
// regardless of where the run physically happened.
const DAY_TZ = 'America/Chicago';

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 60);
const MIN_KM      = 3.2;   // ~2 miles: the threshold the site has always counted
const KM_PER_MILE = 1.60934;

// Runs only. Walks, hikes and rides deliberately do not count.
// (Strava reports a trail run as sport_type "TrailRun" / legacy type "Run",
// and treadmill runs from third-party apps as "VirtualRun".)
const RUN_SPORTS = new Set(['Run', 'TrailRun', 'VirtualRun']);

const FULL_REFRESH = process.env.FULL_REFRESH === '1' || process.argv.includes('--full');
const FORCE_PRUNE  = process.env.FORCE_PRUNE === '1';

// ---------- Helpers ----------
function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }
function readJSON(p){ return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, obj){
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function monthFiles(){
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs.readdirSync(OUT_DIR)
    .filter(n => /^\d{4}-\d{2}\.json$/.test(n))
    .map(n => path.join(OUT_DIR, n))
    .sort();
}

const CT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: DAY_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/**
 * True UTC instant -> Central wall clock, serialised as "YYYY-MM-DDTHH:MM:SSZ".
 * The trailing Z is a lie kept on purpose: the frontend parses start_iso with
 * parseAsCentral() (index.html), i.e. it reads the digits and ignores the Z.
 */
function toCentralISO(utcISO){
  const p = Object.fromEntries(
    CT_FMT.formatToParts(new Date(utcISO))
      .filter(x => x.type !== 'literal')
      .map(x => [x.type, x.value])
  );
  const hour = p.hour === '24' ? '00' : p.hour;   // belt and braces
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}Z`;
}

// month bucket, read straight off the Central wall clock
function ym(centralISO){ return centralISO.slice(0, 7); }

// ---------- Strava ----------
async function refreshAccessToken(){
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    })
  });
  if (!r.ok) throw new Error(`Strava token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function fetchActivities(accessToken, afterUnix){
  let page = 1;
  const per_page = 200, out = [];
  while (true) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('per_page', per_page);
    url.searchParams.set('page', page);
    if (afterUnix) url.searchParams.set('after', afterUnix);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`Strava fetch failed: ${r.status} ${await r.text()}`);
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < per_page) break;
    if (++page > 50) throw new Error('Refusing to page past 10k activities');
  }
  return out;
}

function mapToSnapshotItems(activities){
  return activities
    .filter(a => RUN_SPORTS.has(a.sport_type || a.type))
    .map(a => {
      const start_utc  = new Date(a.start_date).toISOString();
      const start_iso  = toCentralISO(start_utc);   // Central wall clock
      return {
        id: a.id,
        date: start_iso.slice(0, 10),               // Central calendar day
        start_iso,
        start_utc,                                  // true instant, so this is re-derivable
        distance_km: a.distance / 1000,
        moving_time_s: a.moving_time,
        moving_time_min: a.moving_time / 60,
        avg_hr: a.average_heartrate ?? null,
        time_hhmm: start_iso.slice(11, 16),
      };
    })
    .filter(it => it.date >= START_DAY);
}

// ---------- Snapshots ----------
function readStored(){
  const byId = new Map();
  for (const f of monthFiles()) for (const it of readJSON(f)) byId.set(it.id, it);
  return byId;
}

function writeMonths(pool){
  const buckets = new Map();
  for (const it of pool.values()) {
    const key = ym(it.start_iso);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  // rewrite every month that exists on disk too, so an activity that moved to a
  // different month cannot leave a stale copy behind
  for (const f of monthFiles()) if (!buckets.has(path.basename(f, '.json'))) buckets.set(path.basename(f, '.json'), []);

  for (const [key, arr] of buckets) {
    arr.sort((a, b) => a.start_iso.localeCompare(b.start_iso) || String(a.id).localeCompare(String(b.id)));
    writeJSON(path.join(OUT_DIR, `${key}.json`), arr);
  }
}

function buildIndex(){
  const months = [];
  for (const f of monthFiles()) {
    const arr = readJSON(f);
    const qualifying = arr.filter(a => a.distance_km >= MIN_KM);
    const miles = qualifying.reduce((s, a) => s + a.distance_km / KM_PER_MILE, 0);
    months.push({
      ym: path.basename(f, '.json'),
      days: new Set(qualifying.map(a => a.date)).size,
      miles: Number(miles.toFixed(2)),
    });
  }
  months.sort((a, b) => a.ym.localeCompare(b.ym));
  return { start: START_DAY, months, last_update: new Date().toISOString() };
}

// ---------- Main ----------
(async () => {
  ensureDir(OUT_DIR);

  const stored = readStored();
  // Snapshots written before the Central-Time migration have no start_utc and
  // were dated by the *activity's* local clock. Rebuild everything once.
  const needsMigration = [...stored.values()].some(it => !it.start_utc);
  const full = FULL_REFRESH || needsMigration || stored.size === 0;

  const windowStart = full
    ? new Date(START_ISO)
    : new Date(Date.now() - WINDOW_DAYS * 86400000);
  // one day of slack so the exact semantics of Strava's `after` never matter
  const afterUnix = Math.max(0, Math.floor(windowStart.getTime() / 1000) - 86400);

  console.log(
    `Mode: ${full ? (needsMigration ? 'FULL (migrating snapshots to Central Time)' : 'FULL') : `rolling ${WINDOW_DAYS}d`}` +
    `, window starts ${windowStart.toISOString()}`
  );

  const token = await refreshAccessToken();
  const acts  = await fetchActivities(token, afterUnix);
  const items = mapToSnapshotItems(acts);
  const fetchedIds = new Set(items.map(i => i.id));

  // Reconcile: anything the window returned wins; anything inside the window
  // that the window did NOT return is gone from Strava (deleted, or no longer a run).
  const pool = new Map();
  const dropped = [];
  let storedInWindow = 0;
  for (const [id, it] of stored) {
    const inWindow = new Date(it.start_utc ?? it.start_iso) >= windowStart;
    if (inWindow) storedInWindow++;
    if (fetchedIds.has(id)) continue;                       // replaced by a fresh copy below
    if (acts.length && inWindow) { dropped.push(it); continue; }
    pool.set(id, it);
  }
  // Safety valve: a run may only legitimately remove a handful of activities from
  // its own window. Anything more looks like a truncated API response, not real
  // deletions, so keep the data and say so loudly.
  if (dropped.length > 5 && dropped.length > 0.25 * storedInWindow && !FORCE_PRUNE) {
    console.warn(`WARNING: ${dropped.length} of the ${storedInWindow} stored activities inside the window were not returned by Strava. That looks wrong, so they have been KEPT. Re-run with FORCE_PRUNE=1 if they really were deleted.`);
    for (const it of dropped) pool.set(it.id, it);
    dropped.length = 0;
  }

  const canon = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  let added = 0, updated = 0;
  for (const it of items) {
    if (!stored.has(it.id)) added++;
    else if (canon({ ...stored.get(it.id), start_utc: it.start_utc }) !== canon(it)) updated++;
    pool.set(it.id, it);
  }

  writeMonths(pool);
  writeJSON(path.join(OUT_DIR, 'index.json'), buildIndex());

  // ---------- recent 30 days ----------
  const cutoff = new Date(Date.now() - 30 * 86400000);
  const recent = [...pool.values()]
    .filter(it => new Date(it.start_utc ?? it.start_iso) >= cutoff)
    .sort((a, b) => a.start_iso.localeCompare(b.start_iso));
  writeJSON(path.join(OUT_DIR, 'recent-30d.json'), recent);

  const qual = recent.filter(a => a.distance_km >= MIN_KM);
  writeJSON(path.join(OUT_DIR, 'recent-30d-summary.json'), {
    days: new Set(qual.map(a => a.date)).size,
    miles: Number(qual.reduce((s, a) => s + a.distance_km / KM_PER_MILE, 0).toFixed(2)),
    generated_at: new Date().toISOString(),
  });

  // ---------- report ----------
  const runsInWindow = items.length;
  console.log(`Strava returned ${acts.length} activities, ${runsInWindow} of them runs.`);
  console.log(`Snapshots: ${pool.size} total (added ${added}, updated ${updated}, removed ${dropped.length}).`);
  const today = toCentralISO(new Date().toISOString()).slice(0, 10);
  const haveDays = new Set([...pool.values()].filter(a => a.distance_km >= MIN_KM).map(a => a.date));
  const gaps = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (!haveDays.has(key)) gaps.push(key);
  }
  console.log(gaps.length ? `Days with no qualifying run in the last 14: ${gaps.join(', ')}` : 'No gaps in the last 14 days.');
})().catch(e => { console.error(e); process.exit(1); });
