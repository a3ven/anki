const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

function parse(out) {
  let r = out?.response;
  if (r && typeof r === "object") return r;
  const m = String(r || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("bad model output");
  return JSON.parse(m[0]);
}

async function generate(env, word) {
  const attempts = [
    [MODEL, true],
    [MODEL, false],
    ["@cf/google/gemma-4-26b-a4b-it", false],
  ];
  const errs = [];
  for (const [model, jm] of attempts) {
    try {
      const opts = {
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: JSON.stringify(word) },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      };
      if (jm) opts.response_format = { type: "json_object" };
      const out = await env.AI.run(model, opts);
      const d = parse(out);
      if (!d.en || !d.fa) throw new Error("incomplete output");
      d.examples = Array.isArray(d.examples) ? d.examples.slice(0, 3) : [];
      return { data: d };
    } catch (e) {
      const m = String(e.message || e);
      errs.push(`${model.split("/").pop()}${jm ? "+json" : ""}: ${m}`);
      if (m.includes("4006")) break; // daily quota used up: other models share it
    }
  }
  return { error: errs.join(" | ").slice(0, 500) };
}

// ---------- storage: D1 (one row per card) ----------
let ready = false;
async function initDb(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL, synced_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cards_synced ON cards (synced_at)"),
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
      if (r.error) return json({ error: r.error }, 502);
      const now = Date.now();
      const card = {
        id, word, cat: "General", status: "ready", data: r.data,
        due: now, interval: 0, reps: 0, createdAt: now, updatedAt: now,
      };
      await env.DB.prepare(UPSERT).bind(id, JSON.stringify(card), now, now).run();
      return json({ ok: true, word, en: r.data.en, fa: r.data.fa });
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      const { cards = [], since = 0 } = await req.json();
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
        const { results } = await env.DB.prepare("SELECT data FROM cards WHERE synced_at > ?").bind(since).all();
        return json({ cards: results.map((r) => JSON.parse(r.data)), now });
      } catch (e) {
        return json({ error: "db: " + String(e.message || e).slice(0, 200) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
