// Camada de dados. Usa o Supabase quando configurado; senão, o modo demonstração.
import { CONFIG } from "./config.js";

export const MODO_DEMO = !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY;

// Captura o tipo de link de e-mail (convite / recuperação) ANTES do supabase-js
// limpar o endereço. Ex.: #access_token=...&type=invite
const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
export const ACAO_URL = ["invite", "recovery"].includes(hashParams.get("type"))
  ? hashParams.get("type")
  : null;
export const ERRO_URL = hashParams.get("error_description");

// URL para onde os e-mails de convite/senha devem voltar
export const REDIRECT_URL = location.origin + location.pathname;

function check({ data, error }) {
  if (error) throw new Error(traduzErro(error.message));
  return data;
}

function traduzErro(msg = "") {
  if (/Invalid login credentials/i.test(msg)) return "Incorrect e-mail or password.";
  if (/Email not confirmed/i.test(msg)) return "Your invitation has not been accepted yet. Please check your e-mail.";
  if (/Password should be at least/i.test(msg)) return "The password must be at least 8 characters long.";
  if (/New password should be different/i.test(msg)) return "The new password must be different from the previous one.";
  if (/duplicate key/i.test(msg)) return "A record with this name already exists.";
  if (/rate limit/i.test(msg)) return "Too many attempts. Please wait a few minutes.";
  if (/Failed to fetch/i.test(msg)) return "Unable to connect to the server.";
  return msg;
}

function erroPosition(msg = "") {
  if (/bi_position|schema cache|does not exist|Could not find the function/i.test(msg)) return "Position is not set up yet: run section 7 of supabase/schema.sql in the Supabase SQL Editor.";
  if (/Access denied/i.test(msg)) return "Only administrators and file managers can upload the Position.";
  return traduzErro(msg);
}

// =====================================================================
// IMPLEMENTAÇÃO SUPABASE
// =====================================================================
async function criarApiSupabase() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
  });

  async function edge(action, payload = {}) {
    const { data, error } = await sb.functions.invoke("bi-admin-users", {
      body: { action, redirectTo: REDIRECT_URL, ...payload },
    });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error ?? msg; } catch { /* mantém */ }
      throw new Error(traduzErro(msg));
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function sincronizar(tabela, campoFixo, valorFixo, campoLista, novos) {
    const atuais = check(await sb.from(tabela).select(campoLista).eq(campoFixo, valorFixo)).map((r) => r[campoLista]);
    const add = novos.filter((x) => !atuais.includes(x));
    const rem = atuais.filter((x) => !novos.includes(x));
    if (rem.length) check(await sb.from(tabela).delete().eq(campoFixo, valorFixo).in(campoLista, rem));
    if (add.length) check(await sb.from(tabela).insert(add.map((x) => ({ [campoFixo]: valorFixo, [campoLista]: x }))));
  }

  return {
    // ----------------------------------------------------------- auth
    async sessao() {
      const { data } = await sb.auth.getSession();
      return data.session;
    },
    onAuth(cb) { sb.auth.onAuthStateChange((evt, s) => cb(evt, s)); },
    async entrar(email, senha) { check(await sb.auth.signInWithPassword({ email, password: senha })); },
    async sair() { await sb.auth.signOut(); },
    async recuperarSenha(email) {
      check(await sb.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT_URL }));
    },
    // grava a nova senha e encerra a troca obrigatória (senha provisória)
    async definirSenha(senha) { check(await sb.auth.updateUser({ password: senha, data: { trocar_senha: false } })); },
    async meuPerfil() {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return null;
      return check(await sb.from("bi_perfis").select("*").eq("id", user.id).maybeSingle());
    },

    // ----------------------------------------------------------- categorias
    async categorias() { return check(await sb.from("bi_categorias").select("*").order("ordem").order("nome")); },
    async salvarCategoria({ id, ...c }) {
      if (id) check(await sb.from("bi_categorias").update(c).eq("id", id));
      else check(await sb.from("bi_categorias").insert(c));
    },
    async excluirCategoria(id) { check(await sb.from("bi_categorias").delete().eq("id", id)); },

    // ----------------------------------------------------------- dashboards
    async dashboards() {
      return check(await sb.from("bi_dashboards").select("*").order("ordem").order("titulo"));
    },
    async dashboard(id) {
      return check(await sb.from("bi_dashboards").select("*").eq("id", id).maybeSingle());
    },
    async salvarDashboard({ id, ...d }, usuarios) {
      let dashId = id;
      if (id) check(await sb.from("bi_dashboards").update(d).eq("id", id));
      else dashId = check(await sb.from("bi_dashboards").insert(d).select("id").single()).id;
      if (usuarios) await sincronizar("bi_acessos", "dashboard_id", dashId, "user_id", usuarios);
    },
    async excluirDashboard(id) { check(await sb.from("bi_dashboards").delete().eq("id", id)); },
    async marcarAtualizado(id) {
      check(await sb.from("bi_dashboards").update({ atualizado_em: new Date().toISOString() }).eq("id", id));
    },
    async acessosDoDashboard(id) {
      return check(await sb.from("bi_acessos").select("user_id").eq("dashboard_id", id)).map((r) => r.user_id);
    },
    async acessosDoUsuario(uid) {
      return check(await sb.from("bi_acessos").select("dashboard_id").eq("user_id", uid)).map((r) => r.dashboard_id);
    },
    async contagemAcessos() {
      const rows = check(await sb.from("bi_acessos").select("dashboard_id, user_id"));
      return rows;
    },

    // ----------------------------------------------------------- usuários
    async usuarios() {
      const perfis = check(await sb.from("bi_perfis").select("*").order("nome"));
      let status = {};
      try { status = (await edge("status")).status ?? {}; } catch { /* função não publicada */ }
      return perfis.map((p) => ({ ...p, ...(status[p.id] ?? { confirmado: null, trocar_senha: null, ultimo_acesso: null }) }));
    },
    async criarUsuario(u) { return edge("criar", u); },
    async salvarUsuario({ id, nome, is_admin, ativo, gerencia_arquivos }, dashboards) {
      // gerencia_arquivos só vai quando a coluna existe no banco (schema.sql)
      const dados = { nome, is_admin, ativo, ...(gerencia_arquivos !== undefined ? { gerencia_arquivos } : {}) };
      check(await sb.from("bi_perfis").update(dados).eq("id", id));
      if (dashboards) await sincronizar("bi_acessos", "user_id", id, "dashboard_id", dashboards);
    },
    async redefinirSenha(id, senha) { return edge("redefinir", { user_id: id, senha }); },
    async excluirUsuario(id) { return edge("excluir", { user_id: id }); },

    // ----------------------------------------------------------- avisos
    async avisos() {
      return check(await sb.from("bi_avisos").select("*").order("inicio", { ascending: false }));
    },
    async salvarAviso({ id, ...a }) {
      if (id) check(await sb.from("bi_avisos").update(a).eq("id", id));
      else {
        const { data: { user } } = await sb.auth.getUser();
        check(await sb.from("bi_avisos").insert({ ...a, created_by: user.id }));
      }
    },
    async excluirAviso(id) { check(await sb.from("bi_avisos").delete().eq("id", id)); },

    // ----------------------------------------------------------- arquivos
    // null = recurso ainda não instalado no banco (schema.sql, seção 6)
    async arquivos() {
      const { data, error } = await sb.from("bi_arquivos").select("*").order("ordem").order("titulo");
      return error ? null : data;
    },
    async enviarArquivo(file) {
      const seguro = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_");
      const caminho = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${seguro}`;
      check(await sb.storage.from("bi-arquivos").upload(caminho, file, { upsert: false, contentType: file.type || undefined }));
      return { caminho, nome_arquivo: file.name, tamanho: file.size };
    },
    async salvarArquivo({ id, ...a }, usuarios) {
      let arqId = id;
      if (id) check(await sb.from("bi_arquivos").update(a).eq("id", id));
      else arqId = check(await sb.from("bi_arquivos").insert(a).select("id").single()).id;
      if (usuarios) await sincronizar("bi_arquivo_acessos", "arquivo_id", arqId, "user_id", usuarios);
    },
    async removerObjetoArquivo(caminho) { await sb.storage.from("bi-arquivos").remove([caminho]); },
    async excluirArquivo(a) {
      check(await sb.from("bi_arquivos").delete().eq("id", a.id));
      await sb.storage.from("bi-arquivos").remove([a.caminho]);
    },
    async acessosDoArquivo(id) {
      return check(await sb.from("bi_arquivo_acessos").select("user_id").eq("arquivo_id", id)).map((r) => r.user_id);
    },
    async contagemAcessosArquivos() { return check(await sb.from("bi_arquivo_acessos").select("arquivo_id, user_id")); },
    // link temporário (1 min) que já baixa com o nome original
    async linkDownload(a) {
      return check(await sb.storage.from("bi-arquivos").createSignedUrl(a.caminho, 60, { download: a.nome_arquivo })).signedUrl;
    },

    // ----------------------------------------------------------- position (painéis nativos)
    // última planilha publicada (null = nenhuma ainda)
    async positionUltima() {
      const { data, error } = await sb.from("bi_position_cargas").select("id, data_ref, nome_arquivo, enviado_por, resumo, created_at")
        .order("data_ref", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(erroPosition(error.message));
      return data;
    },
    // indicadores de cada dia (última publicação do dia), para os gráficos de evolução
    async positionHistorico() {
      const { data, error } = await sb.from("bi_position_cargas").select("id, data_ref, kpis:resumo->kpis").order("data_ref").order("id");
      if (error) throw new Error(erroPosition(error.message));
      const porDia = new Map(data.map((c) => [c.data_ref, c]));
      return [...porDia.values()].slice(-120);
    },
    // tipos: purchases | expsales | intsales | inventory (Open Contracts), vendas | compras (crop over crop)
    async positionDetalhe(tipos) {
      const { data, error } = await sb.from("bi_position_detalhe").select("tipo, linhas").in("tipo", tipos);
      if (error) throw new Error(erroPosition(error.message));
      if (!data.length) throw new Error("No data available — you may not have access, or the Position needs to be uploaded again.");
      return Object.fromEntries(data.map((r) => [r.tipo, r.linhas]));
    },
    // grava resumo + contratos e marca os painéis como atualizados, tudo numa transação
    async publicarPosition({ data_ref, nome_arquivo, resumo, detalhes, alerta = null }) {
      const { error } = await sb.rpc("bi_position_publicar", { p_data_ref: data_ref, p_nome: nome_arquivo, p_resumo: resumo, p_detalhes: detalhes, p_alerta: alerta });
      if (error) throw new Error(erroPosition(error.message));
    },

    // ----------------------------------------------------------- notificações
    // null = recurso ainda não instalado no banco (schema.sql, seção 5)
    async notificacoes() {
      const { data, error } = await sb.from("bi_notificacoes").select("*")
        .order("created_at", { ascending: false }).limit(30);
      return error ? null : data;
    },
    async marcarNotificacoesVistas() {
      const { data: { user } } = await sb.auth.getUser();
      const agora = new Date().toISOString();
      check(await sb.from("bi_perfis").update({ notif_vistas_em: agora }).eq("id", user.id));
      return agora;
    },
    ouvirNotificacoes(cb) {
      sb.removeAllChannels();
      sb.channel("bi-notificacoes")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "bi_notificacoes" }, (p) => cb(p.new))
        .subscribe();
    },
    pararNotificacoes() { sb.removeAllChannels(); },

    async enviarImagem(file) {
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const caminho = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      check(await sb.storage.from("bi-avisos").upload(caminho, file, { upsert: false, contentType: file.type }));
      return sb.storage.from("bi-avisos").getPublicUrl(caminho).data.publicUrl;
    },
  };
}

// =====================================================================
// IMPLEMENTAÇÃO DEMONSTRAÇÃO (dados fictícios no navegador)
// =====================================================================
async function criarApiDemo() {
  const { criarDemo } = await import("./demo.js");
  return criarDemo();
}

export const api = MODO_DEMO ? await criarApiDemo() : await criarApiSupabase();
