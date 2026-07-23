# UNKSO Jackets API

A small Cloudflare Worker that stores members, ranks, ribbons, and badges in Workers KV,
so the Jackets/Admin/Ranks/Ribbons pages can persist real data.

## 1. Point it at your KV namespace

Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the ID
of the KV namespace you already have. If you need to find it:

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

## 3. Point the site at it

In each of `index.html`, `admin.html`, `ranks.html`, `ribbons.html`, and `badges.html`, find this line
near the top of the `<script>` block:

```js
const API_BASE = 'https://unkso-api.YOUR-SUBDOMAIN.workers.dev';
```

Replace it with your actual Worker URL from step 2 (no trailing slash), in all four files.

## 4. Lock down CORS (recommended before going live)

`src/index.js` currently allows requests from any origin (`ALLOWED_ORIGIN = "*"`),
which is fine for testing. Once your Cloudflare Pages site has its real domain,
change that constant to your site's exact origin, e.g.:

```js
const ALLOWED_ORIGIN = "https://unkso.pages.dev";
```

Then redeploy with `wrangler deploy`.

## API reference

| Method | Path            | Body                  | Returns                          |
|--------|-----------------|------------------------|-----------------------------------|
| GET    | `/api/members`  | —                      | JSON array of members (or `null`) |
| PUT    | `/api/members`  | JSON array of members  | `OK`                              |
| GET    | `/api/ranks`    | —                      | JSON array of rank strings        |
| PUT    | `/api/ranks`    | JSON array of strings  | `OK`                              |
| GET    | `/api/ribbons`  | —                      | JSON array of ribbon objects      |
| PUT    | `/api/ribbons`  | JSON array of objects  | `OK`                              |
| GET    | `/api/badges`   | —                      | JSON array of badge objects       |
| PUT    | `/api/badges`   | JSON array of objects  | `OK`                              |

Each collection is a single KV entry (`unkso-members`, `unkso-ranks`, `unkso-ribbons`, `unkso-badges`) —
every save overwrites the whole array, matching how the site already works.

## Notes / things worth hardening later

- There's no authentication on these endpoints right now — anyone with the Worker URL
  can read or overwrite your roster. Fine while you're the only one touching Admin;
  worth adding a shared secret header or Cloudflare Access before wider rollout.
- No request size limit is enforced beyond KV's own (25 MiB per value, far more than
  you'll need here).
- `PUT` fully overwrites a collection — there's no partial update or conflict detection,
  so two admins saving at the same moment would have the second save win outright.
