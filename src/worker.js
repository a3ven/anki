const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Cloudflare models, tried in this order (first one that works wins).
// [model id, use JSON mode?]
const CF_MODELS = [
  ["@cf/qwen/qwen3.8-27b", false],
  ["@cf/deepseek-ai/deepseek-v4.1-flash-1017", false],
  [MODEL, true],
  [MODEL, false],
];

const SYS = `You build flashcard data for a Persian speaker learning English.
The user gives ONE word or phrase, in English or in Persian.
Reply with ONLY one JSON object, no markdown, no extra text:
{
 "en": "the English word/phrase (if input is Persian, its best English equivalent)",
 "fa": "meaning in COLLOQUIAL spoken Persian (محاوره‌ای تهرانی، نه رسمی و کتابی). 1 to 3 short options separated by ، ",
 "pos": "noun | verb | adjective | adverb | phrase | ...",
 "ipa": "/IPA of the English word/",
 "fa_pron": "English pronunciation written in Persian letters with vowel marks, e.g. اِکس‌پِریِنس",
 "examples": [
  {"en": "natural everyday English sentence using the word", "fa": "its translation in colloquial spoken Persian"},
  {"en": "second sentence, different context", "fa": "colloquial Persian translation"}
 ],
 "note": "optional short usage tip in colloquial Persian, or empty string"
}
Rules: Persian must sound like real speech (e.g. «می‌خوام», «نمی‌دونم», «خیلی باحاله»), never formal or bookish (not «می‌خواهم», «نمی‌دانم»). Examples must be practical, short, and from daily life.`;

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Accepts the different output shapes of Workers AI models:
//  - {response: "..."} or {response: {...}}  (Llama, JSON mode)
//  - {choices:[{message:{content:"..."}}]}   (OpenAI-style: Qwen, DeepSeek, gpt-oss)
//  - {result:{response:"..."}} / {output_text:"..."}
function parse(out) {
  let r =
    out?.response ??
    out?.choices?.[0]?.message?.content ??
    out?.result?.response ??
    out?.output_text;
  if (r && typeof r === "object") return r;
  // reasoning models may print their thinking inside <think>...</think>
  const txt = String(r || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("bad model output");
  return JSON.parse(m[0]);
}

// ---------- AI providers (the order is set in generate() below) ----------
// Each fallback is optional: it is used only if its secret key is set in the Worker.
// Models can be changed without editing code via the *_MODEL variables.
function fallbackProviders(env) {
  const list = [];
  if (env.GEMINI_API_KEY)
    list.push({ name: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-2.5-flash" });
  if (env.GROQ_API_KEY)
    list.push({ name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: env.GROQ_API_KEY, model: env.GROQ_MODEL || "openai/gpt-oss-120b" });
  if (env.OPENROUTER_API_KEY)
    for (const m of [env.OPENROUTER_MODEL || "openrouter/free", "google/gemma-4-31b-it:free"])
      list.push({ name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: env.OPENROUTER_API_KEY, model: m });
  if (env.MISTRAL_API_KEY)
    list.push({ name: "mistral", url: "https://api.mistral.ai/v1/chat/completions", key: env.MISTRAL_API_KEY, model: env.MISTRAL_MODEL || "mistral-small-latest" });
  return list;
}

function finish(d) {
  if (!d || !d.en || !d.fa) throw new Error("incomplete output");
  d.examples = Array.isArray(d.examples) ? d.examples.slice(0, 3) : [];
  return { data: d };
}

async function viaCloudflare(env, word, errs) {
  for (const [model, jm] of CF_MODELS) {
    try {
      const opts = {
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: JSON.stringify(word) },
        ],
        max_tokens: 2500, // a bit more room in case a model "thinks" before answering
        temperature: 0.3,
      };
      if (jm) opts.response_format = { type: "json_object" };
      const out = await env.AI.run(model, opts);
      return finish(parse(out));
    } catch (e) {
      const m = String(e.message || e);
      errs.push(`cf/${model.split("/").pop()}${jm ? "+json" : ""}: ${m}`);
      if (m.includes("4006")) break; // daily quota used up: other CF models share it
    }
  }
  return null;
}

async function viaOpenAICompat(p, word, errs) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const res = await fetch(p.url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + p.key },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: JSON.stringify(word) },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      }),
    });
    clearTimeout(t);
    const body = await res.text();
    if (!res.ok) throw new Error(res.status + " " + body.slice(0, 120));
    const txt = JSON.parse(body)?.choices?.[0]?.message?.content;
    return finish(parse({ response: txt }));
  } catch (e) {
    errs.push(`${p.name}: ${String(e.message || e).slice(0, 150)}`);
    return null; // quota / error -> caller tries the next provider
  }
}

// Order in which the AI services are tried (the first one that answers wins). Services without a key are skipped.
// Change it without editing code: set the AI_ORDER variable in the Worker, e.g. "cloudflare,groq,openrouter".
const DEFAULT_ORDER = "groq,cloudflare,gemini,openrouter,mistral";

async function generate(env, word) {
  const errs = [];
  const fb = fallbackProviders(env);
  const want = String(env.AI_ORDER || DEFAULT_ORDER).toLowerCase().split(/[\s,]+/).filter(Boolean);
  // anything not named in the order is still tried, after the named ones
  const order = [...want, "cloudflare", "gemini", "groq", "openrouter", "mistral"].filter((n, i, a) => a.indexOf(n) === i);
  for (const name of order) {
    if (name === "cloudflare") {
      const cf = await viaCloudflare(env, word, errs);
      if (cf) return cf;
    } else {
      for (const p of fb.filter((x) => x.name === name)) {
        const r = await viaOpenAICompat(p, word, errs);
        if (r) return r;
      }
    }
  }
  // The app shows "quota used up" whenever the error text contains 4006. If fallbacks
  // were tried, hide that code so the real fallback errors are shown instead.
  const hasFallback = fb.length > 0;
  const msg = (hasFallback ? errs.slice().reverse() : errs).join(" | ").replace(hasFallback ? /4006/g : /$^/, "CF-quota");
  return { error: msg.slice(0, 500) };
}

// ---------- users & keys ----------
// APP_KEY (Worker secret) = the admin's key. Every other user has a random key that is
// stored only as a SHA-256 hash in table `users`; the plain key is shown once, when created.
const enc = new TextEncoder();
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

async function authenticate(env, req) {
  const key = req.headers.get("x-app-key") || "";
  if (!key || !env.APP_KEY) return null;
  if (safeEq(key, env.APP_KEY)) return { uid: "admin", admin: true, name: "Admin" };
  await initDb(env);
  const row = await env.DB.prepare("SELECT id, name FROM users WHERE key_hash=?").bind(await sha256(key)).first();
  return row ? { uid: row.id, admin: false, name: row.name } : null;
}

// A key typed by the admin must be 6-64 chars and must not equal the admin key.
// (A key that is empty means: make a random one.)
function pickKey(env, raw) {
  const k = String(raw ?? "").trim();
  if (!k) return { key: rand(16) };
  if (k.length < 6 || k.length > 64) return { error: "key must be 6 to 64 characters" };
  if (safeEq(k, env.APP_KEY)) return { error: "this key is not allowed" };
  return { key: k };
}
const isDup = (e) => /UNIQUE/i.test(String(e && e.message));

async function adminApi(env, url, req) {
  const p = url.pathname, body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (p === "/api/admin/users" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT u.id, u.name, u.created_at, (SELECT COUNT(*) FROM ucards c WHERE c.uid=u.id) AS cards FROM users u ORDER BY u.created_at"
    ).all();
    return json({ users: results });
  }
  if (p === "/api/admin/users" && req.method === "POST") {
    const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return json({ error: "name required" }, 400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (n.n >= 200) return json({ error: "too many users" }, 400);
    const pk = pickKey(env, body.key);
    if (pk.error) return json({ error: pk.error }, 400);
    const id = rand(4), key = pk.key;
    try {
      await env.DB.prepare("INSERT INTO users (id,name,key_hash,created_at) VALUES (?,?,?,?)")
        .bind(id, name, await sha256(key), Date.now()).run();
    } catch (e) {
      if (isDup(e)) return json({ error: "this key is already used, choose another" }, 400);
      throw e;
    }
    return json({ id, name, key });
  }
  if (p === "/api/admin/reset" && req.method === "POST") {
    const pk = pickKey(env, body.key);
    if (pk.error) return json({ error: pk.error }, 400);
    const key = pk.key;
    let r;
    try {
      r = await env.DB.prepare("UPDATE users SET key_hash=? WHERE id=?").bind(await sha256(key), String(body.id || "")).run();
    } catch (e) {
      if (isDup(e)) return json({ error: "this key is already used, choose another" }, 400);
      throw e;
    }
    return r.meta.changes ? json({ id: body.id, key }) : json({ error: "no such user" }, 404);
  }
  if (p === "/api/admin/delete" && req.method === "POST") {
    const id = String(body.id || "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ucards WHERE uid=?").bind(id),
      env.DB.prepare("DELETE FROM usettings WHERE uid=?").bind(id),
      env.DB.prepare("DELETE FROM users WHERE id=?").bind(id),
    ]);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

// ---------- storage: D1 (one row per card, per user) ----------
let ready = false;
async function initDb(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ucards (uid TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, synced_at INTEGER NOT NULL, PRIMARY KEY (uid, id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ucards_synced ON ucards (uid, synced_at, id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS usettings (uid TEXT NOT NULL, k TEXT NOT NULL, v TEXT, t INTEGER NOT NULL, PRIMARY KEY (uid, k))"),
  ]);
  // one-time: move the old single-user deck (table `cards`) to the admin account.
  // The old table is left untouched as a backup.
  const mu = await env.DB.prepare("SELECT v FROM meta WHERE k='multiuser'").first();
  if (!mu) {
    const old = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cards'").first();
    if (old)
      await env.DB.prepare(
        "INSERT OR IGNORE INTO ucards (uid,id,data,updated_at,synced_at) SELECT 'admin', id, data, updated_at, synced_at FROM cards"
      ).run();
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('multiuser','1')").run();
  }
  // one-time import of the old KV deck (if the KV binding still exists)
  const done = await env.DB.prepare("SELECT v FROM meta WHERE k='kv_imported'").first();
  if (!done) {
    if (env.SYNC) {
      const old = (await env.SYNC.get("deck", "json")) || {};
      const now = Date.now();
      const rows = Object.values(old).filter((c) => c && c.id);
      for (let i = 0; i < rows.length; i += 50) {
        await env.DB.batch(
          rows.slice(i, i + 50).map((c) =>
            env.DB.prepare("INSERT OR IGNORE INTO ucards (uid,id,data,updated_at,synced_at) VALUES ('admin',?,?,?,?)")
              .bind(c.id, JSON.stringify(c), c.updatedAt || 0, now)
          )
        );
      }
    }
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('kv_imported','1')").run();
  }
  ready = true;
}

// generates the card content with AI and stores it (only if nothing newer was saved meanwhile)
async function fillCard(env, uid, card) {
  const r = await generate(env, card.word);
  if (r.error) return r;
  const t = Math.max(Date.now(), card.updatedAt + 1);
  const done = { ...card, status: "ready", data: r.data, updatedAt: t };
  await env.DB.prepare(UPSERT).bind(uid, card.id, JSON.stringify(done), t, t).run();
  return r;
}

const UPSERT =
  "INSERT INTO ucards (uid,id,data,updated_at,synced_at) VALUES (?,?,?,?,?) " +
  "ON CONFLICT(uid,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, synced_at=excluded.synced_at " +
  "WHERE excluded.updated_at > ucards.updated_at";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    let me;
    try {
      me = await authenticate(env, req);
    } catch (e) {
      return json({ error: "db: " + String(e.message || e).slice(0, 200) }, 500);
    }
    if (!me) return json({ error: "unauthorized" }, 401);
    const uid = me.uid;

    if (url.pathname === "/api/me") return json({ uid, name: me.name, admin: me.admin });

    // Card settings (front/back layout, pins, order, sort, review parameters) are synced between devices.
    // The client sends the keys it changed ({k, v, t}); the newest change per key wins. The answer is the full state.
    if (url.pathname === "/api/settings" && req.method === "POST") {
      try {
        await initDb(env);
        const body = await req.json().catch(() => ({}));
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 300).filter(
          (x) => x && typeof x.k === "string" && x.k.length <= 120 && Number.isFinite(x.t) &&
            (x.v === null || (typeof x.v === "string" && x.v.length <= 20000))
        );
        if (items.length) {
          const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM usettings WHERE uid=?").bind(uid).first();
          if (cnt.n < 3000)
            await env.DB.batch(items.map((x) =>
              env.DB.prepare(
                "INSERT INTO usettings (uid,k,v,t) VALUES (?,?,?,?) ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v, t=excluded.t WHERE excluded.t > usettings.t"
              ).bind(uid, x.k, x.v, Math.round(x.t))
            ));
        }
        const { results } = await env.DB.prepare("SELECT k, v, t FROM usettings WHERE uid=?").bind(uid).all();
        return json({ items: results });
      } catch (e) {
        return json({ error: "db: " + String(e.message || e).slice(0, 200) }, 500);
      }
    }

    if (url.pathname === "/api/generate" && req.method === "POST") {
      const { word } = await req.json();
      if (!word || word.length > 80) return json({ error: "bad word" }, 400);
      const r = await generate(env, word);
      return r.error ? json({ error: r.error }, 502) : json({ data: r.data });
    }

    try {
      await initDb(env);
    } catch (e) {
      return json({ error: "db: " + String(e.message || e).slice(0, 200) }, 500);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!me.admin) return json({ error: "forbidden" }, 403);
      try {
        return await adminApi(env, url, req);
      } catch (e) {
        return json({ error: "db: " + String(e.message || e).slice(0, 200) }, 500);
      }
    }

    // For Apple Shortcuts: POST {"word": "..."} -> card is generated and saved in category "General"
    if (url.pathname === "/api/add" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const word = String(body.word || "").replace(/\s+/g, " ").trim();
      if (!word || word.length > 60) return json({ error: "bad word" }, 400);
      const id = word.toLowerCase();
      const row = await env.DB.prepare("SELECT data FROM ucards WHERE uid=? AND id=?").bind(uid, id).first();
      if (row && !JSON.parse(row.data).deleted) return json({ ok: true, exists: true, word });
      const now = Date.now();
      // Saved at once as "pending" and the answer is sent immediately; the card is generated in the
      // background (ctx.waitUntil). If that fails or takes too long, the app generates it on its next sync.
      // Send {"word": "...", "wait": true} to get the old behaviour (wait for the translation).
      const card = {
        id, word, cat: "General", status: "pending",
        due: now, interval: 0, reps: 0, createdAt: now, updatedAt: now,
      };
      await env.DB.prepare(UPSERT).bind(uid, id, JSON.stringify(card), now, now).run();
      if (body.wait) {
        const r = await fillCard(env, uid, card);
        if (r.error)
          return json({ ok: true, pending: true, word, message: "ذخیره شد، کارت بعداً ساخته می‌شود", reason: r.error.slice(0, 120) });
        return json({ ok: true, word, en: r.data.en, fa: r.data.fa, message: r.data.fa });
      }
      ctx.waitUntil(fillCard(env, uid, card).catch(() => {}));
      return json({ ok: true, pending: true, word, message: "✓ " + word });
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      // bodies may be gzipped by the app (header x-gz) to survive flaky uploads
      const raw = req.headers.get("x-gz")
        ? await new Response(req.body.pipeThrough(new DecompressionStream("gzip"))).text()
        : await req.text();
      const { cards = [], since = 0, after = "", limit = 0, maxBytes = 0 } = JSON.parse(raw);
      const now = Date.now();
      try {
        const valid = cards.filter((c) => c && c.id);
        for (let i = 0; i < valid.length; i += 50) {
          await env.DB.batch(
            valid.slice(i, i + 50).map((c) =>
              env.DB.prepare(UPSERT).bind(uid, c.id, JSON.stringify(c), c.updatedAt || 0, now)
            )
          );
        }
        // Pulling is paged (limit + cursor) so one response never gets huge and cut off.
        // Rows already hold JSON text, so the response is assembled as a string (cheap on CPU).
        // Old clients send no limit and still get everything in one response.
        const lim = Math.min(Math.max(parseInt(limit) || 0, 0), 500);
        const out = (body) => new Response(body, { headers: { "content-type": "application/json" } });
        if (!lim) {
          const { results } = await env.DB.prepare("SELECT data FROM ucards WHERE uid=? AND synced_at > ?").bind(uid, since).all();
          return out(`{"cards":[${results.map((r) => r.data).join(",")}],"now":${now}}`);
        }
        const { results } = await env.DB.prepare(
          "SELECT id, data, synced_at FROM ucards WHERE uid=? AND (synced_at, id) > (?, ?) ORDER BY synced_at, id LIMIT ?"
        ).bind(uid, since, String(after), lim).all();
        // also cap the page by size (maxBytes), always returning at least one card
        let rows = results, trimmed = false;
        const mb = parseInt(maxBytes) || 0;
        if (mb) {
          let sz = 0, k = 0;
          for (; k < rows.length; k++) {
            sz += rows[k].data.length;
            if (k > 0 && sz > mb) { trimmed = true; break; }
          }
          rows = rows.slice(0, k);
        }
        const last = rows[rows.length - 1];
        return out(
          `{"cards":[${rows.map((r) => r.data).join(",")}],"now":${now},"more":${trimmed || results.length === lim},"cursor":${
            last ? JSON.stringify({ t: last.synced_at, id: last.id }) : "null"
          }}`
        );
      } catch (e) {
        return json({ error: "db: " + String(e.message || e).slice(0, 200) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
