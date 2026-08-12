// UNKSO Jackets API — a tiny GET/PUT JSON store backed by Workers KV, plus
// automated weekly backups of the whole roster (optionally pushed to Discord).
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
//   POST /api/backup-now       -> create a backup immediately (same as the weekly cron does) —
//                                  also notifies Discord if configured, styled as "Manual"
//
// Storage: each collection lives under its own KV key
// ("unkso-members", "unkso-ranks", "unkso-ribbons", "unkso-badges", "unkso-pins")
// inside the bound namespace. Backups are stored as additional KV entries
// under "unkso-backup-<ISO date>", each holding a single JSON object with
// every collection's data at that point in time.
//
// Discord webhook (optional): set a DISCORD_BACKUP_WEBHOOK_URL secret
// (`wrangler secret put DISCORD_BACKUP_WEBHOOK_URL`, or add it as an
// encrypted variable in the Cloudflare dashboard under the Worker's
// Settings -> Variables). If it's not set, backups still run — they just
// skip the Discord notification silently. Both the weekly cron AND the
// manual "backup now" button notify Discord, but with distinct styling
// (bold/orange for the automated weekly one, plain/grey for manual) so
// they're easy to tell apart in the channel.

const ALLOWED_KEYS = ["members", "ranks", "ribbons", "badges", "pins", "tracker"];
const BACKUP_PREFIX = "unkso-backup-";
const BACKUP_RETENTION = 12; // keep the last 12 backups (~3 months at a weekly cadence), prune older ones
const DISCORD_ATTACH_LIMIT = 7.5 * 1024 * 1024; // stay safely under Discord's 8MB default webhook cap

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

function backupTimestampKey() {
  return new Date().toISOString().replace(/[:.]/g, "-"); // e.g. "2026-08-09T14-32-05-123Z", safe as a KV key
}

// Reads every collection and writes one combined snapshot to KV under
// "unkso-backup-<full timestamp>". Keyed by full timestamp (not just date)
// so a manual backup on the same day as the weekly cron never overwrites
// it, or vice versa — each backup gets its own entry no matter how many
// happen in a day. Used by both the weekly cron and the manual "backup
// now" endpoint, tagged with `automated` either way.
async function createBackup(env, automated) {
  const timestamp = new Date().toISOString();
  const snapshot = { createdAt: timestamp, automated, data: {} };
  for (const key of ALLOWED_KEYS) {
    const raw = await env.UNKSO_KV.get("unkso-" + key);
    snapshot.data[key] = raw ? JSON.parse(raw) : null;
  }
  const backupKey = BACKUP_PREFIX + backupTimestampKey();
  await env.UNKSO_KV.put(backupKey, JSON.stringify(snapshot), {
    metadata: { automated, createdAt: timestamp },
  });
  await pruneOldBackups(env);
  return { key: backupKey, id: backupKey.slice(BACKUP_PREFIX.length), date: timestamp.slice(0, 10), createdAt: timestamp, automated };
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

// Posts a notification to a Discord channel via webhook whenever a backup is
// created — whether that's the weekly cron or someone clicking "Download
// Backup Now" on Admin. `automated` controls how it's presented so the two
// are easy to tell apart at a glance: the weekly one is bold/branded, manual
// ones are deliberately plainer. Attaches the actual backup JSON as a file
// if it's small enough; otherwise just notes the size and points at the
// Admin page's Backups panel instead. Failures here (bad URL, Discord down,
// rate limited) are swallowed — a notification problem should never make
// the backup itself look like it failed.
async function notifyDiscordBackup(env, date, snapshotText, automated) {
  const webhookUrl = env.DISCORD_BACKUP_WEBHOOK_URL;
  if (!webhookUrl) return;

  const sizeBytes = new TextEncoder().encode(snapshotText).length;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);

  const embed = automated
    ? {
        title: "🗓️ AUTOMATED WEEKLY BACKUP",
        description: `Runs every Sunday, no one has to remember. Snapshot of members, ranks, ribbons, badges, pins, and tracker data for **${date}**.`,
        color: 0xe35f2e, // site's brand orange — makes the automated one stand out
        timestamp: new Date().toISOString(),
        footer: { text: `Automated • ${sizeMB} MB` },
      }
    : {
        title: "Manual backup",
        description: `Triggered from the Backups panel on Admin. Snapshot for **${date}**.`,
        color: 0x6b7280, // muted grey — deliberately quieter than the automated one
        timestamp: new Date().toISOString(),
        footer: { text: `Manual • ${sizeMB} MB` },
      };

  try {
    if (sizeBytes <= DISCORD_ATTACH_LIMIT) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ embeds: [embed] }));
      form.append("file", new Blob([snapshotText], { type: "application/json" }), `unkso-backup-${date}.json`);
      await fetch(webhookUrl, { method: "POST", body: form });
    } else {
      embed.description += `\n\nToo large to attach here (${sizeMB} MB, over Discord's limit) — download it from the Backups panel on the Admin page instead.`;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
    }
  } catch (err) {
    // Intentionally not re-thrown — see comment above.
  }
}

// Shared by both the weekly cron and the manual "backup now" route, so the
// "create, then notify" sequence can never drift between the two paths.
async function runBackupAndNotify(env, automated) {
  const { key, id, date } = await createBackup(env, automated);
  const snapshotText = await env.UNKSO_KV.get(key);
  await notifyDiscordBackup(env, date, snapshotText, automated);
  return { key, id, date };
}

async function listBackups(env, headers) {
  const list = await env.UNKSO_KV.list({ prefix: BACKUP_PREFIX });
  const backups = list.keys
    .map((k) => ({
      key: k.name,
      id: k.name.slice(BACKUP_PREFIX.length), // use this in GET /api/backups/:id
      date: k.name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10),
      createdAt: k.metadata?.createdAt ?? null,
      automated: k.metadata?.automated ?? null,
    }))
    .sort((a, b) => (a.key < b.key ? 1 : -1)); // newest first — timestamp keys sort chronologically as strings
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
    const backupMatch = url.pathname.match(/^\/api\/backups\/([0-9TZ-]+)$/);
    if (backupMatch && request.method === "GET") {
      const raw = await env.UNKSO_KV.get(BACKUP_PREFIX + backupMatch[1]);
      if (!raw) return new Response("Backup not found", { status: 404, headers });
      return new Response(raw, { headers: { "Content-Type": "application/json", ...headers } });
    }

    // POST /api/backup-now
    if (url.pathname === "/api/backup-now" && request.method === "POST") {
      const result = await runBackupAndNotify(env, false);
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
    ctx.waitUntil(runBackupAndNotify(env, true));
  },
};
