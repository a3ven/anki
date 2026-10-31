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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.APP_KEY || req.headers.get("x-app-key") !== env.APP_KEY)
      return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/api/generate" && req.method === "POST") {
      const { word } = await req.json();
      if (!word || word.length > 80) return json({ error: "bad word" }, 400);
      try {
        const out = await env.AI.run(MODEL, {
          messages: [
            { role: "system", content: SYS },
            { role: "user", content: JSON.stringify(word) },
          ],
          max_tokens: 900,
          temperature: 0.3,
        });
        const d = parse(out);
        if (!d.en || !d.fa) throw new Error("incomplete");
        d.examples = Array.isArray(d.examples) ? d.examples.slice(0, 3) : [];
        return json({ data: d });
      } catch (e) {
        return json({ error: String(e.message || e) }, 502);
      }
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      const { cards = [], since = 0 } = await req.json();
      const store = (await env.SYNC.get("deck", "json")) || {};
      const now = Date.now();
      for (const c of cards) {
        const old = store[c.id];
        if (!old || c.updatedAt > old.updatedAt) store[c.id] = { ...c, syncedAt: now };
      }
      if (cards.length) await env.SYNC.put("deck", JSON.stringify(store));
      const out = Object.values(store).filter((c) => c.syncedAt > since);
      return json({ cards: out, now });
    }

    return json({ error: "not found" }, 404);
  },
};
