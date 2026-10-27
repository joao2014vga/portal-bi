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

// partes do resumo que as telas usam (a "pegada" dos contratos fica de fora)
const CHAVES_RESUMO = ["versao", "termm", "fisica", "variacao", "kpis", "origem", "alteracoes", "alteracoes_ultima"];
const PARTES_RESUMO = CHAVES_RESUMO.map((k) => `r_${k}:resumo->${k}`).join(", ");
function montarCarga(c) {
  if (!c) return c;
  const resumo = {};
  for (const k of CHAVES_RESUMO) { if (c[`r_${k}`] != null) resumo[k] = c[`r_${k}`]; delete c[`r_${k}`]; }
  return { ...c, resumo };
}

// coluna "fonte" ainda não existe (seção 9 do schema não rodada)
const semColunaFonte = (error) => /fonte/i.test(error?.message ?? "") && /does not exist|column/i.test(error.message);

function erroPosition(msg = "") {
  if (/bi_position_modelo|bi_config|salvar_modelo|definir_fonte|publicar_api/i.test(msg)) return "The Digisul update is not set up yet: run section 9 of supabase/schema.sql in the Supabase SQL Editor.";
  if (/bi_position|schema cache|does not exist|Could not find the function/i.test(msg)) return "Position is not set up yet: run section 7 of supabase/schema.sql in the Supabase SQL Editor.";
  if (/Access denied/i.test(msg)) return "Only administrators and file managers can upload the Position.";
  return traduzErro(msg);
}

function erroCert(msg = "") {
  if (/bi_cert_ajustes|schema cache|does not exist/i.test(msg)) return "Certificates are not set up yet: run section 11 of supabase/schema.sql in the Supabase SQL Editor.";
  if (/row-level security|permission denied/i.test(msg)) return "Only administrators and file managers can change the certificate list.";
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
    // fonte: "planilha" (upload) ou "api" (sincronização com o Digisul). Sem a seção 9
    // do schema ainda não existe a coluna "fonte" e tudo é planilha.
    // última publicação da fonte (null = nenhuma ainda)
    async positionUltima(fonte = "planilha") {
      // o resumo vem por partes: a "pegada" dos contratos (usada só na comparação) fica no banco
      const consulta = (comFonte) => {
        let q = sb.from("bi_position_cargas").select(`id, data_ref, nome_arquivo, enviado_por, created_at, ${PARTES_RESUMO}`);
        if (comFonte) q = q.eq("fonte", fonte);
        return q.order("data_ref", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
      };
      let { data, error } = await consulta(true);
      if (error && semColunaFonte(error)) {
        if (fonte === "api") return null;
        ({ data, error } = await consulta(false));
      }
      if (error) throw new Error(erroPosition(error.message));
      return montarCarga(data);
    },
    // pegada da última versão de um dia anterior (null = não há);
    // sem data_ref: a versão mais recente, de qualquer dia ("desde a última atualização")
    async positionPegadaAnterior(fonte, data_ref = null) {
      const consulta = (comFonte) => {
        let q = sb.from("bi_position_cargas").select("data_ref, created_at, pegada:resumo->pegada").not("resumo->pegada", "is", null);
        if (data_ref) q = q.lt("data_ref", data_ref);
        if (comFonte) q = q.eq("fonte", fonte);
        return q.order("data_ref", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
      };
      let { data, error } = await consulta(true);
      if (error && semColunaFonte(error)) ({ data, error } = await consulta(false));
      return error || !data ? null : data;
    },
    // indicadores de cada dia (última publicação do dia), para os gráficos de evolução
    async positionHistorico(fonte = "planilha") {
      const consulta = (comFonte) => {
        let q = sb.from("bi_position_cargas").select("id, data_ref, kpis:resumo->kpis");
        if (comFonte) q = q.eq("fonte", fonte);
        return q.order("data_ref").order("id");
      };
      let { data, error } = await consulta(true);
      if (error && semColunaFonte(error)) ({ data, error } = fonte === "api" ? { data: [], error: null } : await consulta(false));
      if (error) throw new Error(erroPosition(error.message));
      const porDia = new Map(data.map((c) => [c.data_ref, c]));
      return [...porDia.values()].slice(-120);
    },
    // tipos: purchases | expsales | intsales | inventory (Open Contracts), vendas | compras (crop over crop)
    async positionDetalhe(tipos, fonte = "planilha") {
      const consulta = (comFonte) => {
        let q = sb.from("bi_position_detalhe").select("tipo, linhas").in("tipo", tipos);
        if (comFonte) q = q.eq("fonte", fonte);
        return q;
      };
      let { data, error } = await consulta(true);
      if (error && semColunaFonte(error) && fonte !== "api") ({ data, error } = await consulta(false));
      if (error) throw new Error(erroPosition(error.message));
      if (!data.length) throw new Error("No data available — you may not have access, or the Position needs to be uploaded again.");
      return Object.fromEntries(data.map((r) => [r.tipo, r.linhas]));
    },
    // qual fonte os painéis mostram (configurada pelo ADM)
    async positionFonte() {
      const { data, error } = await sb.from("bi_config").select("valor").eq("chave", "position_fonte").maybeSingle();
      return !error && data?.valor === "api" ? "api" : "planilha";
    },
    async definirFontePosition(fonte) {
      const { error } = await sb.rpc("bi_position_definir_fonte", { p_fonte: fonte });
      if (error) throw new Error(erroPosition(error.message));
    },
    // quando e de qual arquivo vieram as fórmulas e os futuros usados pela API (null = ainda não há)
    async positionModeloInfo() {
      const { data, error } = await sb.from("bi_position_modelo").select("atualizado_em, nome_arquivo, enviado_por, futuros:modelo->futuros")
        .eq("id", 1).maybeSingle();
      if (error || !data) return null;
      return { ...data, futuros: data.futuros?.length ?? 0 };
    },
    async positionModelo() {
      const { data, error } = await sb.from("bi_position_modelo").select("modelo").eq("id", 1).maybeSingle();
      if (error) throw new Error(erroPosition(error.message));
      return data?.modelo ?? null;
    },
    async salvarPositionModelo(modelo, nome_arquivo) {
      const { error } = await sb.rpc("bi_position_salvar_modelo", { p_modelo: modelo, p_nome: nome_arquivo });
      if (error) throw new Error(erroPosition(error.message));
    },
    // pede ao servidor (brascof-api) para buscar o Digisul e recalcular agora
    async sincronizarPosition() {
      const { data: { session } } = await sb.auth.getSession();
      let res;
      try {
        res = await fetch(`${CONFIG.API_BRASCOF}/api/position-sync`, { method: "POST", headers: { Authorization: `Bearer ${session?.access_token ?? ""}` } });
      } catch {
        throw new Error("Unable to reach the update service. Please try again.");
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `The update failed (${res.status}).`);
      return j;
    },
    // grava resumo + contratos e marca os painéis como atualizados, tudo numa transação
    async publicarPosition({ data_ref, nome_arquivo, resumo, detalhes, alerta = null }) {
      const { error } = await sb.rpc("bi_position_publicar", { p_data_ref: data_ref, p_nome: nome_arquivo, p_resumo: resumo, p_detalhes: detalhes, p_alerta: alerta });
      if (error) throw new Error(erroPosition(error.message));
    },

    // ----------------------------------------------------------- certificados
    // todas as compras e exportações gravadas pela sincronização (null = ainda não há)
    async certBase() {
      const { data, error } = await sb.from("bi_position_detalhe").select("tipo, linhas, updated_at")
        .eq("fonte", "api").in("tipo", ["cert_compras", "cert_vendas"]);
      if (error) throw new Error(erroCert(error.message));
      if (data.length < 2) return null;
      const d = Object.fromEntries(data.map((r) => [r.tipo, r]));
      return { compras: d.cert_compras.linhas, vendas: d.cert_vendas.linhas, atualizado_em: d.cert_compras.updated_at };
    },
    async certAjustes(certificado) {
      const { data, error } = await sb.from("bi_cert_ajustes").select("*").eq("certificado", certificado).order("created_at");
      if (error) throw new Error(erroCert(error.message));
      return data;
    },
    // um ajuste ou uma lista (inclusão em lote)
    async salvarCertAjuste(ajustes) {
      const linhas = [].concat(ajustes).map(({ certificado, tipo, contrato, acao = "incluir", sacas = null, obs = null }) =>
        ({ certificado, tipo, contrato, acao, sacas, obs }));
      const { error } = await sb.from("bi_cert_ajustes").upsert(linhas, { onConflict: "certificado,tipo,contrato" });
      if (error) throw new Error(erroCert(error.message));
    },
    async removerCertAjuste(id) {
      const { error } = await sb.from("bi_cert_ajustes").delete().eq("id", id);
      if (error) throw new Error(erroCert(error.message));
    },
    // histórico importado da planilha (null = seção 13 do schema ainda não rodada)
    async certHistorico(certificado) {
      const { data, error } = await sb.from("bi_cert_historico").select("*").eq("certificado", certificado).order("ordem");
      if (error) {
        if (/bi_cert_historico|schema cache|does not exist/i.test(error.message)) return null;
        throw new Error(erroCert(error.message));
      }
      return data;
    },
    async importarCertHistorico(certificado, linhas) {
      const { data, error } = await sb.rpc("bi_cert_historico_importar", { p_certificado: certificado, p_linhas: linhas });
      if (error) {
        if (/bi_cert_historico|schema cache|does not exist/i.test(error.message)) throw new Error("The certificate history is not set up yet: run section 13 of supabase/schema.sql in the Supabase SQL Editor.");
        throw new Error(erroCert(error.message));
      }
      return data;
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
