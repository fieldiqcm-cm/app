// FieldIQ · avisos (notificações) para o telemóvel dos jogadores.
// GET  -> devolve a chave pública (o par de chaves é criado aqui na 1.ª vez e fica só no servidor).
// POST (gestão)  -> envia o aviso para os aparelhos do cliente.
// POST (jogador) -> {tipo:'pedido'|'mensagem'|'loja'|'pago'}: avisa o analista (texto feito aqui, a partir dos dados do servidor).
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
    const user = quem.data.user;
    if (!user) return resposta({ erro: "sem sessão" }, 401);
    const corpo = await req.json();
    webpush.setVapidDetails("mailto:" + GESTOR, k.publicKey, k.privateKey);

    // jogador -> analista
    if ((user.email ?? "").toLowerCase() !== GESTOR) {
      const { data: c } = await admin.from("clientes").select("id,email,extra").eq("user_id", user.id).maybeSingle();
      if (!c) return resposta({ erro: "sem permissão" }, 403);
      const { data: pf } = await admin.from("perfis").select("dados").eq("cliente_id", c.id).maybeSingle();
      const nome = (pf?.dados?.nome as string) || (c.extra?.nome as string) || c.email.split("@")[0];
      let titulo = "", texto = "", abrir = "./gestao#painel";
      if (corpo.tipo === "pedido") {
        const { data: a } = await admin.from("analises").select("jogo,nivel,data_txt").eq("cliente_id", c.id).order("criado_em", { ascending: false }).limit(1).maybeSingle();
        titulo = "Novo pedido de análise · " + nome;
        texto = [a?.jogo, a?.data_txt, a?.nivel].filter(Boolean).join(" · ") || "Abre a gestão para veres o pedido.";
        abrir = "./gestao#cliente-" + c.id;
      } else if (corpo.tipo === "mensagem") {
        const { data: m } = await admin.from("mensagens").select("texto").eq("cliente_id", c.id).eq("autor", "cliente").order("criado_em", { ascending: false }).limit(1).maybeSingle();
        titulo = "Nova mensagem · " + nome;
        texto = String(m?.texto ?? "").slice(0, 120);
        abrir = "./gestao#duvidas";
      } else if (corpo.tipo === "loja" || corpo.tipo === "pago") {
        const { data: pd } = await admin.from("pedidos").select("ref,produto,valor,estado").eq("id", corpo.pedido_id ?? "").eq("cliente_id", c.id).maybeSingle();
        if (!pd) return resposta({ erro: "pedido não encontrado" }, 404);
        titulo = (corpo.tipo === "loja" ? "Novo pedido na loja · " : "Diz que já pagou · ") + nome;
        texto = pd.produto + " · " + String(pd.valor).replace(".", ",") + " € · " + pd.ref;
        abrir = "./gestao#loja";
      } else return resposta({ erro: "tipo desconhecido" }, 400);
      const { data: gs } = await admin.from("push_gestor").select("*");
      let n = 0;
      for (const s of gs ?? []) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ titulo, texto, url: abrir }));
          n++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await admin.from("push_gestor").delete().eq("endpoint", s.endpoint);
        }
      }
      return resposta({ enviados: n });
    }

    // analista -> jogador
    if (corpo.chave) return resposta({ publicKey: k.publicKey });
    const { cliente_id, titulo, texto, abrir } = corpo;
    if (!cliente_id) return resposta({ erro: "falta o cliente" }, 400);
    const { data: subs } = await admin.from("push_subs").select("*").eq("cliente_id", cliente_id);
    let enviados = 0;
    const erros: unknown[] = [];
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ titulo: titulo || "FieldIQ", texto: texto || "", url: abrir || "./#inicio" }),
          { TTL: 86400, urgency: "high" },
        );
        enviados++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        const info = { quando: new Date().toISOString(), servico: new URL(s.endpoint).host, code, body: String((e as { body?: string }).body ?? (e as Error).message ?? e).slice(0, 300) };
        console.error("push falhou", JSON.stringify(info));
        erros.push(info);
        if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    }
    if (erros.length) await admin.from("config_privada").upsert([{ k: "ultimo_erro_push", v: JSON.stringify(erros) }]);
    return resposta({ enviados, aparelhos: (subs ?? []).length, erros });
  } catch (e) {
    return resposta({ erro: String(e) }, 500);
  }
});
