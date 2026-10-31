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

    // For Apple Shortcuts: POST {"word": "..."} -> card is generated and saved in category "General"
    if (url.pathname === "/api/add" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const word = String(body.word || "").replace(/\s+/g, " ").trim();
      if (!word || word.length > 60) return json({ error: "bad word" }, 400);
      const id = word.toLowerCase();
      const store = (await env.SYNC.get("deck", "json")) || {};
      if (store[id] && !store[id].deleted) return json({ ok: true, exists: true, word });
      const r = await generate(env, word);
      if (r.error) return json({ error: r.error }, 502);
      const now = Date.now();
      const fresh = (await env.SYNC.get("deck", "json")) || {};
      fresh[id] = {
        id, word, cat: "General", status: "ready", data: r.data,
        due: now, interval: 0, reps: 0, createdAt: now, updatedAt: now, syncedAt: now,
      };
      await env.SYNC.put("deck", JSON.stringify(fresh));
      return json({ ok: true, word, en: r.data.en, fa: r.data.fa });
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      const { cards = [], since = 0 } = await req.json();
      const store = (await env.SYNC.get("deck", "json")) || {};
      const now = Date.now();
      let changed = false;
      for (const c of cards) {
        const old = store[c.id];
        if (!old || c.updatedAt > old.updatedAt) {
          store[c.id] = { ...c, syncedAt: now };
          changed = true;
        }
      }
      if (changed) {
        try {
          await env.SYNC.put("deck", JSON.stringify(store));
        } catch (e) {
          return json({ error: "kv: " + String(e.message || e).slice(0, 200) }, 500);
        }
      }
      const out = Object.values(store).filter((c) => c.syncedAt > since);
      return json({ cards: out, now });
    }

    return json({ error: "not found" }, 404);
  },
};
