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
  if (/Invalid login credentials/i.test(msg)) return "E-mail ou senha incorretos.";
  if (/Email not confirmed/i.test(msg)) return "Seu convite ainda não foi aceito. Verifique seu e-mail.";
  if (/Password should be at least/i.test(msg)) return "A senha deve ter pelo menos 8 caracteres.";
  if (/New password should be different/i.test(msg)) return "A nova senha deve ser diferente da anterior.";
  if (/duplicate key/i.test(msg)) return "Já existe um registro com esse nome.";
  if (/rate limit/i.test(msg)) return "Muitas tentativas. Aguarde alguns minutos.";
  if (/Failed to fetch/i.test(msg)) return "Sem conexão com o servidor.";
  return msg;
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
    async definirSenha(senha) { check(await sb.auth.updateUser({ password: senha })); },
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
      return perfis.map((p) => ({ ...p, ...(status[p.id] ?? { confirmado: null, ultimo_acesso: null }) }));
    },
    async convidarUsuario(u) { return edge("convidar", u); },
    async salvarUsuario({ id, nome, is_admin, ativo }, dashboards) {
      check(await sb.from("bi_perfis").update({ nome, is_admin, ativo }).eq("id", id));
      if (dashboards) await sincronizar("bi_acessos", "user_id", id, "dashboard_id", dashboards);
    },
    async reenviarConvite(id) { return edge("reenviar", { user_id: id }); },
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
