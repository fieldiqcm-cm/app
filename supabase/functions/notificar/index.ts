// FieldIQ · avisos (notificações) para o telemóvel dos jogadores.
// GET  -> devolve a chave pública (o par de chaves é criado aqui na 1.ª vez e fica só no servidor).
// POST -> só a conta de gestão: envia o aviso para os aparelhos do cliente.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const GESTOR = "fieldiqcm@gmail.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function chaves(): Promise<{ publicKey: string; privateKey: string }> {
  const { data } = await admin.from("config_privada").select("k,v").in("k", ["vapid_pub", "vapid_priv"]);
  const m: Record<string, string> = {};
  (data ?? []).forEach((r: { k: string; v: string }) => (m[r.k] = r.v));
  if (m.vapid_pub && m.vapid_priv) return { publicKey: m.vapid_pub, privateKey: m.vapid_priv };
  const novas = webpush.generateVAPIDKeys();
  await admin.from("config_privada").upsert([{ k: "vapid_pub", v: novas.publicKey }, { k: "vapid_priv", v: novas.privateKey }]);
  return novas;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const k = await chaves();
    if (req.method === "GET") return resposta({ publicKey: k.publicKey });

    const quem = await createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }).auth.getUser();
    if ((quem.data.user?.email ?? "").toLowerCase() !== GESTOR) return resposta({ erro: "sem permissão" }, 403);

    const corpo = await req.json();
    if (corpo.chave) return resposta({ publicKey: k.publicKey });
    const { cliente_id, titulo, texto, abrir } = corpo;
    if (!cliente_id) return resposta({ erro: "falta o cliente" }, 400);

    webpush.setVapidDetails("mailto:" + GESTOR, k.publicKey, k.privateKey);
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
