# UNKSO Jackets API

A small Cloudflare Worker that stores members, ranks, ribbons, badges, pins,
and tracker data in Workers KV, so the site's pages can persist real data —
plus a weekly automated backup of everything, optionally posted to Discord.

## 1. Point it at your KV namespace

Open `wrangler.toml` and set `id` under `[[kv_namespaces]]` to the ID
of the KV namespace you're using. If you need to find it:

```
wrangler kv namespace list
```

If you'd rather create a fresh namespace instead of reusing an existing one:

```
wrangler kv namespace create UNKSO_KV
```

That command prints an `id` — paste it into `wrangler.toml`.

## 2. Deploy

```
cd unkso-worker
wrangler deploy
```

This prints your Worker's URL, something like:

```
https://unkso-api.adambramfitt.workers.dev
```

Deploying also registers the weekly cron trigger defined in `wrangler.toml`
(Sundays, 00:00 UTC) — no separate step needed for that.

## 3. Point the site at it

In every page's `<script>` block (`index.html`, `admin.html`, `ranks.html`,
`ribbons.html`, `badges.html`, `pins.html`, `tracker.html`), find this line
near the top:

```js
const API_BASE = 'https://unkso-api.YOUR-SUBDOMAIN.workers.dev';
```

Replace it with your actual Worker URL from step 2 (no trailing slash), in
every file.

## 4. Lock down CORS (recommended before going live)

`src/index.js` currently allows requests from any origin (`ALLOWED_ORIGIN = "*"`),
which is fine for testing. Once your Cloudflare Pages site has its real domain,
change that constant to your site's exact origin, e.g.:

```js
const ALLOWED_ORIGIN = "https://unkso.pages.dev";
```

Then redeploy with `wrangler deploy`.

## 5. (Optional) Post backups to Discord

Set a `DISCORD_BACKUP_WEBHOOK_URL` secret and the Worker will post a
notification — with the backup file attached, if it's small enough — to
that channel **every time a backup is created**, whether that's the
automated weekly one or someone clicking "Download Backup Now" on Admin.
The two are styled differently so they're easy to tell apart in the
channel: the automated weekly backup gets a bold orange embed titled
"AUTOMATED WEEKLY BACKUP"; manual ones get a plain grey embed just titled
"Manual backup".

**Create the webhook in Discord:**
Channel Settings → Integrations → Webhooks → New Webhook → copy its URL.

**Give the Worker that URL** — either:

```
wrangler secret put DISCORD_BACKUP_WEBHOOK_URL
```
(paste the URL when prompted), or via the Cloudflare dashboard: your Worker →
Settings → Variables → add an **encrypted** variable named
`DISCORD_BACKUP_WEBHOOK_URL`.

Don't put the webhook URL in `wrangler.toml` — anyone with that URL can post
to your channel, and `wrangler.toml` is plain text (and easy to accidentally
commit somewhere public). Secrets are the right place for it.

If a backup is too large to attach directly (over ~7.5MB, Discord's file-size
cap), the Worker posts a text notice instead, pointing back at the Admin
page's Backups panel.

## API reference

| Method | Path              | Body                   | Returns                                          |
|--------|-------------------|-------------------------|----------------------------------------------------|
| GET    | `/api/members`    | —                       | JSON array of members (or `null`)                   |
| PUT    | `/api/members`    | JSON array of members   | `OK`                                                |
| GET    | `/api/ranks`      | —                       | JSON array of rank objects                          |
| PUT    | `/api/ranks`      | JSON array of objects   | `OK`                                                |
| GET    | `/api/ribbons`    | —                       | JSON array of ribbon objects                        |
| PUT    | `/api/ribbons`    | JSON array of objects   | `OK`                                                |
| GET    | `/api/badges`     | —                       | JSON array of badge objects                         |
| PUT    | `/api/badges`     | JSON array of objects   | `OK`                                                |
| GET    | `/api/pins`       | —                       | JSON array of pin objects                           |
| PUT    | `/api/pins`       | JSON array of objects   | `OK`                                                |
| GET    | `/api/tracker`    | —                       | Tracker data (badge-earned records)                 |
| PUT    | `/api/tracker`    | Tracker data            | `OK`                                                |
| GET    | `/api/backups`    | —                       | `[{ key, id, date, createdAt, automated }, ...]`, newest first |
| GET    | `/api/backups/:id`| —                       | Full JSON snapshot for that backup (`id` from the list above) |
| POST   | `/api/backup-now` | —                       | `{ key, id, date }` for the backup just made         |

Each of `members`/`ranks`/`ribbons`/`badges`/`pins`/`tracker` is a single KV
entry (`unkso-members`, `unkso-ranks`, etc.) — every save overwrites the
whole collection, matching how the site already works.

Backups are keyed by full timestamp, not just date (`unkso-backup-<ISO
timestamp>`) — so a manual backup made the same day as the automated weekly
one never overwrites it, or vice versa. Each is tagged `automated: true` or
`false` so the Admin page's Backups list (and the Discord notification) can
tell them apart. The weekly cron creates a new one and prunes anything past
the most recent 12 overall (automated and manual combined).

## Notes / things worth hardening later

- There's no authentication on these endpoints right now — anyone with the Worker URL
  can read or overwrite your roster. The site's own password gate is client-side only
  and doesn't protect the API itself; worth adding a shared secret header or
  Cloudflare Access before wider rollout.
- No request size limit is enforced beyond KV's own (25 MiB per value, far more than
  you'll need here).
- `PUT` fully overwrites a collection — there's no partial update or conflict detection,
  so two admins saving at the same moment would have the second save win outright.
- Cron schedules run in UTC regardless of your own timezone — double-check
  `wrangler.toml`'s `crons` value if Sunday 00:00 UTC isn't when you'd expect
  the backup to land locally.
