// FieldIQ · servidor da app (Cloudflare Worker)
// - Tudo o que não é /api/* são os ficheiros da app (index.html, gestao.html, …).
// - /api/v/* trata dos vídeos das análises guardados no R2 (bucket "fieldiq-videos"):
//     · só a conta de gestão carrega e apaga vídeos;
//     · cada jogador só recebe links para os vídeos das análises dele (a regra vem da base de dados, RLS);
//     · os links expiram ao fim de 6 horas.
// Não há chaves secretas neste ficheiro: a chave que assina os links é criada pelo próprio servidor
// e fica guardada só dentro do R2.

const SUPA = "https://nafmkdnsncbmbgolyvvm.supabase.co";
// chave "anon" pública (a mesma de assets/fiq-config.js)
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hZm1rZG5zbmNibWJnb2x5dnZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwNjI2ODgsImV4cCI6MjExMDYzODY4OH0.qsq4LTlnYiEUNNmBOUZzOQH_0BXWc28wa-4z8uio94w";
const GESTOR = "fieldiqcm@gmail.com";
const VALIDADE = 6 * 3600; // segundos
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let chaveCache = null;
async function chave(env) {
  if (chaveCache) return chaveCache;
  let raw;
  const o = await env.VIDEOS.get("_sistema/chave-links");
  if (o) raw = new Uint8Array(await o.arrayBuffer());
  else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await env.VIDEOS.put("_sistema/chave-links", raw);
  }
  chaveCache = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return chaveCache;
}
async function assinar(env, key, exp) {
  return b64u(await crypto.subtle.sign("HMAC", await chave(env), new TextEncoder().encode(key + "|" + exp)));
}
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const quem = new Map();
async function utilizador(req) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const c = quem.get(auth);
  if (c && c.ate > Date.now()) return c.u;
  const r = await fetch(SUPA + "/auth/v1/user", { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  if (quem.size > 300) quem.clear();
  quem.set(auth, { u, ate: Date.now() + 120000 });
  return u;
}
const eGestor = (u) => !!u && String(u.email || "").toLowerCase() === GESTOR;

async function api(req, env, url) {
  const p = url.pathname;

  // ----- ver o vídeo (link assinado; funciona dentro de <video>) -----
  if (p.startsWith("/api/v/s/") && (req.method === "GET" || req.method === "HEAD")) {
    const key = decodeURIComponent(p.slice("/api/v/s/".length));
    const exp = +url.searchParams.get("e"), s = url.searchParams.get("s") || "";
    if (!key.startsWith("videos/") || !(exp > Date.now() / 1000)) return new Response("Link expirado", { status: 403 });
    if (!iguais(s, await assinar(env, key, exp))) return new Response("Link inválido", { status: 403 });
    const h = new Headers({ "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" });
    if (req.method === "HEAD") {
      const o = await env.VIDEOS.head(key);
      if (!o) return new Response(null, { status: 404 });
      o.writeHttpMetadata(h); h.set("Content-Length", String(o.size)); h.set("ETag", o.httpEtag);
      return new Response(null, { headers: h });
    }
    const o = await env.VIDEOS.get(key, { range: req.headers });
    if (!o) return new Response("Não encontrado", { status: 404 });
    o.writeHttpMetadata(h); h.set("ETag", o.httpEtag);
    if (!h.get("Content-Type")) h.set("Content-Type", "video/mp4");
    if (req.headers.get("Range") && o.range) {
      const r = o.range;
      const ini = r.suffix != null ? o.size - r.suffix : (r.offset || 0);
      const tam = r.suffix != null ? r.suffix : (r.length != null ? r.length : o.size - ini);
      h.set("Content-Range", `bytes ${ini}-${ini + tam - 1}/${o.size}`);
      h.set("Content-Length", String(tam));
      return new Response(o.body, { status: 206, headers: h });
    }
    h.set("Content-Length", String(o.size));
    return new Response(o.body, { headers: h });
  }

  const u = await utilizador(req);
  if (!u) return json({ erro: "sem sessão" }, 401);

  // ----- pedir o link de uma análise (jogador dono da análise ou gestão) -----
  if (p === "/api/v/token" && req.method === "POST") {
    const { analise_id } = await req.json().catch(() => ({}));
    if (!UUID.test(analise_id || "")) return json({ erro: "análise inválida" }, 400);
    const r = await fetch(`${SUPA}/rest/v1/analises?id=eq.${analise_id}&select=id,video_key`, {
      headers: { apikey: ANON, Authorization: req.headers.get("Authorization") },
    });
    const l = r.ok ? await r.json() : [];
    const key = l[0] && l[0].video_key;
    if (!key) return json({ erro: "sem vídeo" }, 404);
    const exp = Math.floor(Date.now() / 1000) + VALIDADE;
    return json({ url: `/api/v/s/${encodeURIComponent(key)}?e=${exp}&s=${await assinar(env, key, exp)}`, ate: exp });
  }

  // ----- daqui para baixo, só a conta de gestão -----
  if (!eGestor(u)) return json({ erro: "sem permissão" }, 403);

  if (p === "/api/v/up/start" && req.method === "POST") {
    const { analise_id, tipo, nome } = await req.json().catch(() => ({}));
    if (!UUID.test(analise_id || "")) return json({ erro: "análise inválida" }, 400);
    const ext = /webm/.test(tipo || "") ? "webm" : /quicktime/.test(tipo || "") ? "mov" : "mp4";
    const key = `videos/${analise_id}/${crypto.randomUUID()}.${ext}`;
    const m = await env.VIDEOS.createMultipartUpload(key, {
      httpMetadata: { contentType: tipo && /^video\//.test(tipo) ? tipo : "video/mp4" },
      customMetadata: { nome: String(nome || "").slice(0, 120) },
    });
    return json({ key, uploadId: m.uploadId });
  }
  if (p === "/api/v/up/part" && req.method === "PUT") {
    const key = url.searchParams.get("key") || "", id = url.searchParams.get("uploadId") || "", n = +url.searchParams.get("n");
    if (!key.startsWith("videos/") || !id || !(n >= 1 && n <= 10000)) return json({ erro: "pedido inválido" }, 400);
    const parte = await env.VIDEOS.resumeMultipartUpload(key, id).uploadPart(n, await req.arrayBuffer());
    return json({ partNumber: parte.partNumber, etag: parte.etag });
  }
  if (p === "/api/v/up/end" && req.method === "POST") {
    const { key, uploadId, parts } = await req.json().catch(() => ({}));
    if (!String(key || "").startsWith("videos/") || !uploadId || !Array.isArray(parts)) return json({ erro: "pedido inválido" }, 400);
    const o = await env.VIDEOS.resumeMultipartUpload(key, uploadId).complete(parts);
    return json({ key, tamanho: o.size });
  }
  if (p === "/api/v/up/abort" && req.method === "POST") {
    const { key, uploadId } = await req.json().catch(() => ({}));
    if (String(key || "").startsWith("videos/") && uploadId) await env.VIDEOS.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
    return json({ ok: true });
  }
  if (p === "/api/v/del" && req.method === "POST") {
    const { key } = await req.json().catch(() => ({}));
    if (!String(key || "").startsWith("videos/")) return json({ erro: "pedido inválido" }, 400);
    await env.VIDEOS.delete(key);
    return json({ ok: true });
  }
  return json({ erro: "não encontrado" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.VIDEOS) return json({ erro: "vídeos ainda não ativados" }, 503);
      try { return await api(req, env, url); }
      catch (e) { return json({ erro: String(e && e.message || e) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
