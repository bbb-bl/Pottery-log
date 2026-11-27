// Pottery Log: "Name it for me". Suggests Hungarian names for a piece from its photos and details.
// The Gemini key stays here on the server (secret GEMINI_API_KEY); only logged-in users can call this.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Tried in order: if one model is unavailable or out of free quota, the next is used.
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 1. Only logged-in Pottery Log users
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: u, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !u?.user) return json({ error: "not_signed_in" }, 401);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "no_key" }, 500);

  // 2. Read the piece details and up to 2 small photos
  let body: { facts?: string; images?: string[]; lang?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const facts = String(body.facts || "").slice(0, 2000);
  const en = body.lang === "en"; // the site's language; Hungarian unless the site is in English
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((x) => typeof x === "string" && x.length < 1_500_000).slice(0, 2);

  const prompt =
    `You are helping a potter name a handmade ceramic piece in their studio log.` +
    (images.length ? " The attached photo shows the piece, or a sketch or work in progress of it." : " There is no photo; use the details.") +
    `\n\nDetails:\n${facts}\n\n` +
    (en
      ? `Suggest 5 short, distinctive names in English, 2 to 4 words each. `
      : `Suggest 5 short, distinctive names in Hungarian, 2 to 4 words each, with correct Hungarian accents. `) +
    `Base every name on the SHAPE of the piece: its silhouette and proportions (tall, squat, slender, rounded, bellied, flared), ` +
    `the neck, shoulder, rim, foot and handle, and the form type (vase, bowl, mug…). ` +
    `Do NOT mention colours, glaze colours or colour words. No quotation marks, no numbering. ` +
    `Reply with only a JSON array of 5 strings, for example ` +
    (en ? `["Slender-necked vase","Round-bellied jug"].` : `["Karcsú nyakú váza","Öblös hasú korsó"].`);

  const parts: unknown[] = [{ text: prompt }, ...images.map((d) => ({ inline_data: { mime_type: "image/jpeg", data: d } }))];

  // 3. Ask Gemini
  let last = "failed";
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 1 },
      }),
    });
    if (r.status === 404 || r.status === 429 || r.status >= 500) { last = r.status === 429 ? "rate_limited" : "failed"; continue; }
    if (!r.ok) return json({ error: r.status === 400 ? "image_rejected" : "failed" }, 502);
    const out = await r.json();
    const text = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
    let names: unknown = [];
    try { names = JSON.parse(text); } catch { const m = text.match(/\[[\s\S]*\]/); if (m) try { names = JSON.parse(m[0]); } catch { /* ignore */ } }
    const list = (Array.isArray(names) ? names : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
    return json({ names: list, model });
  }
  return json({ error: last }, last === "rate_limited" ? 429 : 502);
});
