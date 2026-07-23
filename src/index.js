// UNKSO Jackets API — a tiny GET/PUT JSON store backed by Workers KV.
//
// Routes:
//   GET  /api/members   -> returns the stored members array (or null if never saved)
//   PUT  /api/members    -> body is the new members array (raw JSON), overwrites what's stored
//   GET  /api/ranks   PUT /api/ranks     -> same idea, for the ranks list
//   GET  /api/ribbons PUT /api/ribbons   -> same idea, for the ribbons list
//   GET  /api/badges  PUT /api/badges    -> same idea, for the badges list
//
// Storage: each collection lives under its own KV key
// ("unkso-members", "unkso-ranks", "unkso-ribbons", "unkso-badges") inside the bound namespace.

const ALLOWED_KEYS = ["members", "ranks", "ribbons", "badges"];

// Lock this down to your actual Pages domain once it's live, e.g.
// "https://unkso.pages.dev" — using "*" for now so it works while you're testing.
const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

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
};
