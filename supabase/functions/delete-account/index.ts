// Pottery Log: "Delete my account". Removes the signed-in user's photos, pieces, firings,
// settings and login. Only the user themself can call it (their login token is checked).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// The server-only admin key. Supabase provides it to every Edge Function automatically.
function adminKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || Object.values(keys)[0] as string || "";
  } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const key = adminKey();
  if (!key) return json({ error: "no_admin_key" }, 500);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });

  // 1. Who is asking? Only a logged-in user, and only for their own account.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !u?.user) return json({ error: "not_signed_in" }, 401);
  const id = u.user.id;

  // 2. Photos (stored in the user's own folder)
  for (let round = 0; round < 50; round++) {
    const { data: files, error } = await admin.storage.from("photos").list(id, { limit: 1000 });
    if (error) return json({ error: "photos" }, 500);
    if (!files || !files.length) break;
    const { error: rmErr } = await admin.storage.from("photos").remove(files.map((f) => `${id}/${f.name}`));
    if (rmErr) return json({ error: "photos" }, 500);
  }

  // 3. Pieces, firings, settings
  for (const t of ["pieces", "firings", "settings"]) {
    const { error } = await admin.from(t).delete().eq("user_id", id);
    if (error) return json({ error: "rows" }, 500);
  }

  // 4. The login itself
  const { error: delErr } = await admin.auth.admin.deleteUser(id);
  if (delErr) return json({ error: "user" }, 500);

  return json({ ok: true });
});
