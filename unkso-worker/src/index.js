// UNKSO Jackets API — a tiny GET/PUT JSON store backed by Workers KV, plus
// automated weekly backups of the whole roster.
//
// Routes:
//   GET  /api/members   -> returns the stored members array (or null if never saved)
//   PUT  /api/members    -> body is the new members array (raw JSON), overwrites what's stored
//   GET  /api/ranks   PUT /api/ranks     -> same idea, for the ranks list
//   GET  /api/ribbons PUT /api/ribbons   -> same idea, for the ribbons list
//   GET  /api/badges  PUT /api/badges    -> same idea, for the badges list
//   GET  /api/pins    PUT /api/pins      -> same idea, for the pins list
//
//   GET  /api/backups          -> list available backups: [{ key, date }, ...] newest first
//   GET  /api/backups/:date    -> fetch one backup's full JSON snapshot
//   POST /api/backup-now       -> create a backup immediately (same as the weekly cron does)
//
// Storage: each collection lives under its own KV key
// ("unkso-members", "unkso-ranks", "unkso-ribbons", "unkso-badges", "unkso-pins")
// inside the bound namespace. Backups are stored as additional KV entries
// under "unkso-backup-<ISO date>", each holding a single JSON object with
// every collection's data at that point in time.

const ALLOWED_KEYS = ["members", "ranks", "ribbons", "badges", "pins"];
const BACKUP_PREFIX = "unkso-backup-";
const BACKUP_RETENTION = 12; // keep the last 12 backups (~3 months at a weekly cadence), prune older ones

// Lock this down to your actual Pages domain once it's live, e.g.
// "https://unkso.pages.dev" — using "*" for now so it works while you're testing.
const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// Reads every collection and writes one combined snapshot to KV under
// "unkso-backup-<today>". Used by both the weekly cron and the manual
// "backup now" endpoint, so they can never drift out of sync with each other.
async function createBackup(env) {
  const snapshot = { createdAt: new Date().toISOString(), data: {} };
  for (const key of ALLOWED_KEYS) {
    const raw = await env.UNKSO_KV.get("unkso-" + key);
    snapshot.data[key] = raw ? JSON.parse(raw) : null;
  }
  const backupKey = BACKUP_PREFIX + todayKey();
  await env.UNKSO_KV.put(backupKey, JSON.stringify(snapshot));
  await pruneOldBackups(env);
  return { key: backupKey, date: todayKey() };
}

async function pruneOldBackups(env) {
  const list = await env.UNKSO_KV.list({ prefix: BACKUP_PREFIX });
  const keys = list.keys.map((k) => k.name).sort(); // ISO dates sort chronologically as strings
  const excess = keys.length - BACKUP_RETENTION;
  if (excess > 0) {
    for (const oldKey of keys.slice(0, excess)) {
      await env.UNKSO_KV.delete(oldKey);
    }
  }
}

async function listBackups(env, headers) {
  const list = await env.UNKSO_KV.list({ prefix: BACKUP_PREFIX });
  const backups = list.keys
    .map((k) => ({ key: k.name, date: k.name.slice(BACKUP_PREFIX.length) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  return new Response(JSON.stringify(backups), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // GET /api/backups
    if (url.pathname === "/api/backups" && request.method === "GET") {
      return listBackups(env, headers);
    }

    // GET /api/backups/:date
    const backupMatch = url.pathname.match(/^\/api\/backups\/([0-9-]+)$/);
    if (backupMatch && request.method === "GET") {
      const raw = await env.UNKSO_KV.get(BACKUP_PREFIX + backupMatch[1]);
      if (!raw) return new Response("Backup not found", { status: 404, headers });
      return new Response(raw, { headers: { "Content-Type": "application/json", ...headers } });
    }

    // POST /api/backup-now
    if (url.pathname === "/api/backup-now" && request.method === "POST") {
      const result = await createBackup(env);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    // GET/PUT /api/<collection>
    const match = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404, headers });
    }

    const key = match[1];
    if (!ALLOWED_KEYS.includes(key)) {
      return new Response(`Unknown collection "${key}"`, { status: 404, headers });
    }

    const storeKey = "unkso-" + key;

    if (request.method === "GET") {
      const value = await env.UNKSO_KV.get(storeKey);
      return new Response(value ?? "null", {
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.text();
        JSON.parse(body); // validate it's actually JSON before we store it
      } catch (err) {
        return new Response("Request body must be valid JSON", { status: 400, headers });
      }
      await env.UNKSO_KV.put(storeKey, body);
      return new Response("OK", { headers });
    }

    return new Response("Method not allowed", { status: 405, headers });
  },

  // Cloudflare calls this automatically per the cron schedule in wrangler.toml —
  // no HTTP request involved, nothing needs to visit the site for this to run.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(createBackup(env));
  },
};
