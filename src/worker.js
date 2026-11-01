const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Cloudflare models, tried in this order (first one that works wins).
// [model id, use JSON mode?]
const CF_MODELS = [
  ["@cf/qwen/qwen3.8-27b", false],
  ["@cf/deepseek-ai/deepseek-v4-flash-0731", false],
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

// ---------- AI providers: Cloudflare first, then fallbacks ----------
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

async function generate(env, word) {
  const errs = [];
  const cf = await viaCloudflare(env, word, errs);
  if (cf) return cf;
  for (const p of fallbackProviders(env)) {
    const r = await viaOpenAICompat(p, word, errs);
    if (r) return r;
  }
  // The app shows "quota used up" whenever the error text contains 4006. If fallbacks
  // were tried, hide that code so the real fallback errors are shown instead.
  const hasFallback = fallbackProviders(env).length > 0;
  const msg = (hasFallback ? errs.slice().reverse() : errs).join(" | ").replace(hasFallback ? /4006/g : /$^/, "CF-quota");
  return { error: msg.slice(0, 500) };
}

// ---------- storage: D1 (one row per card) ----------
let ready = false;
async function initDb(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL, synced_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cards_synced ON cards (synced_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cards_synced_id ON cards (synced_at, id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
  ]);
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
            env.DB.prepare("INSERT OR IGNORE INTO cards (id,data,updated_at,synced_at) VALUES (?,?,?,?)")
              .bind(c.id, JSON.stringify(c), c.updatedAt || 0, now)
          )
        );
      }
    }
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('kv_imported','1')").run();
  }
  ready = true;
}

const UPSERT =
  "INSERT INTO cards (id,data,updated_at,synced_at) VALUES (?,?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, synced_at=excluded.synced_at " +
  "WHERE excluded.updated_at > cards.updated_at";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.APP_KEY || req.headers.get("x-app-key") !== env.APP_KEY)
      return json({ error: "unauthorized" }, 401);

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

    // For Apple Shortcuts: POST {"word": "..."} -> card is generated and saved in category "General"
    if (url.pathname === "/api/add" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const word = String(body.word || "").replace(/\s+/g, " ").trim();
      if (!word || word.length > 60) return json({ error: "bad word" }, 400);
      const id = word.toLowerCase();
      const row = await env.DB.prepare("SELECT data FROM cards WHERE id=?").bind(id).first();
      if (row && !JSON.parse(row.data).deleted) return json({ ok: true, exists: true, word });
      const r = await generate(env, word);
      const now = Date.now();
      // If AI fails (e.g. daily quota used up) the word is still saved as "pending";
      // the app generates it automatically the next time it syncs.
      const card = {
        id, word, cat: "General", status: r.error ? "pending" : "ready",
        due: now, interval: 0, reps: 0, createdAt: now, updatedAt: now,
      };
      if (!r.error) card.data = r.data;
      await env.DB.prepare(UPSERT).bind(id, JSON.stringify(card), now, now).run();
      if (r.error)
        return json({ ok: true, pending: true, word, message: "ذخیره شد، کارت بعداً ساخته می‌شود", reason: r.error.slice(0, 120) });
      return json({ ok: true, word, en: r.data.en, fa: r.data.fa, message: r.data.fa });
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
              env.DB.prepare(UPSERT).bind(c.id, JSON.stringify(c), c.updatedAt || 0, now)
            )
          );
        }
        // Pulling is paged (limit + cursor) so one response never gets huge and cut off.
        // Rows already hold JSON text, so the response is assembled as a string (cheap on CPU).
        // Old clients send no limit and still get everything in one response.
        const lim = Math.min(Math.max(parseInt(limit) || 0, 0), 500);
        const out = (body) => new Response(body, { headers: { "content-type": "application/json" } });
        if (!lim) {
          const { results } = await env.DB.prepare("SELECT data FROM cards WHERE synced_at > ?").bind(since).all();
          return out(`{"cards":[${results.map((r) => r.data).join(",")}],"now":${now}}`);
        }
        const { results } = await env.DB.prepare(
          "SELECT id, data, synced_at FROM cards WHERE (synced_at, id) > (?, ?) ORDER BY synced_at, id LIMIT ?"
        ).bind(since, String(after), lim).all();
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
