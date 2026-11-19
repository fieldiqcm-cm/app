// FieldIQ · envia avisos (notificações) para o telemóvel dos jogadores.
// Só a conta de gestão pode chamar esta função. A chave privada VAPID está no segredo VAPID_PRIVATE.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const GESTOR = "fieldiqcm@gmail.com";
const VAPID_PUBLIC = "BKi68g1GYEXhWVfUxw4oMp9BVB2dnBvqNCnsm0JktvF_mkXmRyec9A6ghzgabyVlcsfRRCrPjtWt8KuP22I8cUE";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const privada = Deno.env.get("VAPID_PRIVATE");
    if (!privada) return resposta({ erro: "falta o segredo VAPID_PRIVATE" }, 500);

    const quem = await createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }).auth.getUser();
    if ((quem.data.user?.email ?? "").toLowerCase() !== GESTOR) return resposta({ erro: "sem permissão" }, 403);

    const { cliente_id, titulo, texto, abrir } = await req.json();
    if (!cliente_id) return resposta({ erro: "falta o cliente" }, 400);

    webpush.setVapidDetails("mailto:" + GESTOR, VAPID_PUBLIC, privada);
    const admin = createClient(url, service);
    const { data: subs } = await admin.from("push_subs").select("*").eq("cliente_id", cliente_id);
    let enviados = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ titulo: titulo || "FieldIQ", texto: texto || "", url: abrir || "./#inicio" }),
        );
        enviados++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    }
    return resposta({ enviados, aparelhos: (subs ?? []).length });
  } catch (e) {
    return resposta({ erro: String(e) }, 500);
  }
});
