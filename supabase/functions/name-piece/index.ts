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
const DAILY_LIMIT = 20; // "Name it for me" uses per person per day

// The server-only admin key, provided to every Edge Function automatically.
function adminKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || (Object.values(keys)[0] as string) || "";
  } catch { return ""; }
}

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

  // 1b. Daily limit per user (counted in the ai_usage table, which only this server can touch)
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), { auth: { persistSession: false } });
  const { data: used, error: limErr } = await admin.rpc("ai_take", { p_user: u.user.id });
  if (limErr) return json({ error: "limit_check" }, 500);
  if ((used as number) > DAILY_LIMIT) return json({ error: "daily_limit", left: 0 }, 429);
  const left = DAILY_LIMIT - (used as number);

  // 2. Read the piece details and up to 2 small photos
  let body: { facts?: string; images?: string[]; lang?: string; task?: string; targetH?: number };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const facts = String(body.facts || "").slice(0, 2000);
  const en = body.lang === "en"; // the site's language; Hungarian unless the site is in English
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((x) => typeof x === "string" && x.length < 1_500_000).slice(0, 2);

  if (body.task === "sketch") return sketch(key, images, en, Number(body.targetH) || 300, left);

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
    return json({ names: list, model, left });
  }
  return json({ error: last }, last === "rate_limited" ? 429 : 502);
});

// "Recreate from a sketch": read a vase drawing and return the Vase Designer's settings.
async function sketch(key: string, images: string[], en: boolean, targetH: number, left: number) {
  if (!images.length) return json({ error: "no_image" }, 400);
  const prompt =
    `A potter drew a vase. Read the drawing and describe its form with the settings of a vase design tool. ` +
    `The form is turned (round) or faceted, built bottom to top: foot, a lower wall up to the widest "edge" or shoulder, an upper wall up to the mouth, and an optional straight collar/neck on top.\n` +
    `Settings (all sizes are FIRED millimetres):\n` +
    `H total height 80-600; footD foot diameter 30-400; edgeD diameter at the widest edge/shoulder 40-500; edgeAt height of that edge as % of H, 15-92; ` +
    `mouthD mouth diameter 20-400; neckH height of a straight collar on top, 0-120 (0 if none); ` +
    `curveL lower wall shape -100..100 (0 straight line from foot to edge, positive bulges outward/convex, negative curves inward/concave); curveU the same for the upper wall from edge to collar; ` +
    `soft rounding of the edge 0-30 (0 = sharp angle, about 15-30 = a smooth rounded belly); facL and facU number of flat sides below and above the edge, 2 = round, 3-16 = faceted; ` +
    `twist facet twist in degrees -180..180 (0 unless the facets clearly spiral); tilt edge tilt in degrees -25..25 (0 unless the edge line is clearly slanted).\n` +
    `If the drawing has written measurements, use them. Otherwise keep the proportions of the drawing and set H to ${Math.round(targetH)}. ` +
    `Ignore handles, decoration and colour; the tool cannot make handles.\n` +
    `Reply with only a JSON object with exactly these keys: H, footD, edgeD, edgeAt, mouthD, neckH, curveL, curveU, soft, facL, facU, twist, tilt, note. ` +
    `"note" is one short sentence in ${en ? "English" : "Hungarian"} saying what you read from the drawing and anything you could not match.`;
  const parts: unknown[] = [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: images[0] } }];
  let last = "failed";
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    if (r.status === 404 || r.status === 429 || r.status >= 500) { last = r.status === 429 ? "rate_limited" : "failed"; continue; }
    if (!r.ok) return json({ error: r.status === 400 ? "image_rejected" : "failed" }, 502);
    const out = await r.json();
    const text = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
    let obj: Record<string, unknown> = {};
    try { obj = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) try { obj = JSON.parse(m[0]); } catch { /* ignore */ } }
    const params: Record<string, number> = {};
    for (const k of ["H", "footD", "edgeD", "edgeAt", "mouthD", "neckH", "curveL", "curveU", "soft", "facL", "facU", "twist", "tilt"]) {
      const v = Number(obj[k]); if (Number.isFinite(v)) params[k] = v;
    }
    if (!Object.keys(params).length) return json({ error: "no_form" }, 422);
    return json({ params, note: String(obj.note || "").slice(0, 300), model, left });
  }
  return json({ error: last }, last === "rate_limited" ? 429 : 502);
}
