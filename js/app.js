import { CONFIG } from "./config.js";
import { api, MODO_DEMO, ACAO_URL, ERRO_URL } from "./api.js";
import {
  esc, $, $$, icon, toast, modal, confirmar, tempoRelativo, dataBR, dataHoraBR,
  toLocalInput, fromLocalInput, statusAtualizacao, FREQ_LABEL, NIVEL_ICON, iniciais, saudacao, storage,
} from "./ui.js";

const app = $("#app");
const estado = { perfil: null, precisaSenha: ACAO_URL, sistemas: null };

// Sistema integrado: "painel" cujo link fica no mesmo endereço do portal
// (ex.: o Informativo). Abre dentro do portal usando o mesmo login e
// aparece também no menu do topo.
function ehSistema(d) {
  try { return new URL(d.link).origin === location.origin; } catch { return false; }
}

document.title = CONFIG.NOME_PORTAL;

// =====================================================================
// INICIALIZAÇÃO E ROTAS
// =====================================================================
async function iniciar() {
  if (!location.hash.startsWith("#/")) history.replaceState(null, "", location.pathname + location.search + "#/");

  api.onAuth(async (evt) => {
    if (evt === "PASSWORD_RECOVERY") { estado.precisaSenha = "recovery"; rota(); }
    if (evt === "SIGNED_OUT") { estado.perfil = null; rota(); }
  });

  if (ERRO_URL) toast(ERRO_URL.includes("expired") ? "O link expirou. Peça um novo ao administrador." : ERRO_URL, "erro");
  window.addEventListener("hashchange", rota);
  await rota();
}

async function rota() {
  const sessao = await api.sessao();
  if (!sessao) {
    estado.perfil = null;
    return telaLogin();
  }
  if (!estado.perfil) {
    estado.sistemas = null;
    try { estado.perfil = await api.meuPerfil(); } catch (e) { estado.perfil = null; }
    if (!estado.perfil) { await api.sair(); return telaLogin("Perfil não encontrado. Fale com o administrador."); }
    if (!estado.perfil.ativo) { await api.sair(); return telaLogin("Seu acesso está desativado. Fale com o administrador."); }
  }
  if (estado.precisaSenha) return telaDefinirSenha();

  const partes = location.hash.slice(2).split("/").filter(Boolean);
  const [secao, sub] = partes;

  try {
    if (!secao) return await telaInicio();
    if (secao === "d" && sub) return await telaDashboard(sub);
    if (secao === "avisos") return await telaAvisos();
    if (secao === "admin") {
      if (!estado.perfil.is_admin) { location.hash = "#/"; return; }
      return await telaAdmin(sub || "dashboards");
    }
    location.hash = "#/";
  } catch (e) {
    console.error(e);
    shell(`<div class="vazio">${icon("alert")}<h3>Não foi possível carregar</h3><p>${esc(e.message)}</p></div>`);
  }
}

// =====================================================================
// LOGIN
// =====================================================================
function telaLogin(msg) {
  document.body.className = "pg-login";
  app.innerHTML = `
  <main class="login">
    <section class="login-arte" aria-hidden="true">
      <div class="login-marca">${logo()}<span>${esc(CONFIG.NOME_PORTAL)}</span></div>
      <div class="login-frase">
        <h1>Todos os painéis da ${esc(CONFIG.NOME_EMPRESA)} em um só lugar.</h1>
        <p>Indicadores, avisos e status de atualização para decidir com dados confiáveis.</p>
      </div>
      <svg class="login-graf" viewBox="0 0 400 160" preserveAspectRatio="none">
        <path d="M0 140 L50 120 L100 128 L150 90 L200 100 L250 60 L300 72 L350 30 L400 40" />
        <g>${[30, 55, 45, 75, 65, 95, 85, 120].map((v, i) => `<rect x="${i * 50 + 12}" y="${160 - v}" width="26" height="${v}" rx="3"/>`).join("")}</g>
      </svg>
    </section>

    <section class="login-form-wrap">
      <form class="login-form" id="fLogin" novalidate>
        <span class="logo login-logo"><img src="assets/logo_brascof.png" alt="${esc(CONFIG.NOME_EMPRESA)}"></span>
        <h2>Entrar</h2>
        <p class="muted">Use o e-mail cadastrado pela equipe de BI.</p>
        ${msg ? `<div class="aviso-inline alerta">${icon("alert")}<span>${esc(msg)}</span></div>` : ""}
        <label class="campo"><span>E-mail</span>
          <input type="email" name="email" autocomplete="username" required placeholder="nome@empresa.com.br"></label>
        <label class="campo"><span>Senha</span>
          <input type="password" name="senha" autocomplete="current-password" required placeholder="••••••••"></label>
        <p class="form-erro" aria-live="polite"></p>
        <button class="btn btn-primary btn-bloco" type="submit">Entrar</button>
        <button class="link" type="button" id="esqueci">Esqueci minha senha</button>
        ${MODO_DEMO ? `
          <div class="demo-box">
            <strong>Modo demonstração</strong>
            <p>ADM: <code>admin@demo.com</code> · Usuário: <code>mariana@demo.com</code><br>Senha: <code>demo1234</code></p>
          </div>` : ""}
      </form>
    </section>
  </main>`;

  const f = $("#fLogin");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $(".form-erro", f);
    const btn = $("button[type=submit]", f);
    erro.textContent = "";
    if (!f.email.value || !f.senha.value) { erro.textContent = "Informe e-mail e senha."; return; }
    btn.disabled = true; btn.classList.add("loading");
    try {
      await api.entrar(f.email.value.trim(), f.senha.value);
      estado.perfil = null;
      if (location.hash !== "#/") location.hash = "#/"; else await rota();
    } catch (err) {
      erro.textContent = err.message;
    } finally { btn.disabled = false; btn.classList.remove("loading"); }
  });

  $("#esqueci").addEventListener("click", () => {
    modal({
      titulo: "Recuperar senha",
      botao: "Enviar link",
      corpo: `<p class="muted">Enviaremos um link para você criar uma nova senha.</p>
        <label class="campo"><span>E-mail</span><input type="email" name="email" required value="${esc(f.email.value)}"></label>`,
      onSubmit: async (m) => {
        if (!m.email.value) throw new Error("Informe o e-mail.");
        await api.recuperarSenha(m.email.value.trim());
        toast("Se o e-mail estiver cadastrado, você receberá o link em instantes.");
      },
    });
  });
}

function telaDefinirSenha() {
  document.body.className = "pg-login";
  const convite = estado.precisaSenha === "invite";
  app.innerHTML = `
  <main class="login login-simples">
    <section class="login-form-wrap">
      <form class="login-form" id="fSenha" novalidate>
        <div class="login-marca">${logo()}<span>${esc(CONFIG.NOME_PORTAL)}</span></div>
        <h2>${convite ? `Bem-vindo(a), ${esc(estado.perfil.nome.split(" ")[0])}!` : "Criar nova senha"}</h2>
        <p class="muted">${convite ? "Defina sua senha para acessar o portal." : "Escolha uma nova senha para sua conta."}</p>
        <label class="campo"><span>Nova senha</span>
          <input type="password" name="s1" autocomplete="new-password" minlength="8" required></label>
        <label class="campo"><span>Confirmar senha</span>
          <input type="password" name="s2" autocomplete="new-password" minlength="8" required></label>
        <p class="dica">Mínimo de 8 caracteres.</p>
        <p class="form-erro" aria-live="polite"></p>
        <button class="btn btn-primary btn-bloco" type="submit">Salvar senha</button>
      </form>
    </section>
  </main>`;
  const f = $("#fSenha");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $(".form-erro", f);
    erro.textContent = "";
    if (f.s1.value.length < 8) return (erro.textContent = "A senha deve ter pelo menos 8 caracteres.");
    if (f.s1.value !== f.s2.value) return (erro.textContent = "As senhas não conferem.");
    try {
      await api.definirSenha(f.s1.value);
      estado.precisaSenha = null;
      toast("Senha definida com sucesso!");
      location.hash = "#/"; rota();
    } catch (err) { erro.textContent = err.message; }
  });
}

// =====================================================================
// ESTRUTURA (cabeçalho + banner)
// =====================================================================
const logo = () => `<span class="logo"><img src="assets/logo_brascof.png" alt=""></span>`;

async function shell(conteudo, { ativo = "", banner = true, cheio = false } = {}) {
  document.body.className = cheio ? "pg-app pg-cheio" : "pg-app";
  const p = estado.perfil;
  const banners = banner ? await bannersVigentes() : [];
  estado.sistemas ??= (await api.dashboards()).filter((d) => d.ativo && ehSistema(d));
  app.innerHTML = `
  <header class="topo">
    <a class="topo-marca" href="#/">${logo()}<span>${esc(CONFIG.NOME_PORTAL)}</span></a>
    <nav class="topo-nav">
      <a href="#/" class="${ativo === "inicio" ? "on" : ""}">${icon("home")}<span>Início</span></a>
      ${estado.sistemas.map((d) => `<a href="#/d/${d.id}" class="${ativo === `d${d.id}` ? "on" : ""}">${icon("grid")}<span>${esc(d.titulo)}</span></a>`).join("")}
      <a href="#/avisos" class="${ativo === "avisos" ? "on" : ""}">${icon("megaphone")}<span>Avisos</span></a>
      ${p.is_admin ? `<a href="#/admin" class="${ativo === "admin" ? "on" : ""}">${icon("settings")}<span>Administração</span></a>` : ""}
    </nav>
    <div class="topo-user">
      <span class="avatar" title="${esc(p.email)}">${esc(iniciais(p.nome))}</span>
      <span class="topo-nome">${esc(p.nome.split(" ")[0] || p.email)}</span>
      <button class="btn-icon" id="sair" title="Sair" aria-label="Sair">${icon("logout")}</button>
    </div>
  </header>
  ${MODO_DEMO ? `<div class="faixa-demo">Modo demonstração — dados fictícios salvos só neste navegador. <button class="link" id="resetDemo">Restaurar dados</button></div>` : ""}
  ${banners.map((b) => `
    <div class="banner banner-${esc(b.nivel)}" data-banner="${b.id}">
      ${icon(NIVEL_ICON[b.nivel])}
      <div><strong>${esc(b.titulo)}</strong>${b.conteudo ? ` <span>${esc(b.conteudo)}</span>` : ""}
      ${b.link ? ` <a href="${esc(b.link)}" target="_blank" rel="noopener">Saiba mais</a>` : ""}</div>
      <button class="btn-icon" data-fecha-banner="${b.id}" aria-label="Fechar aviso">${icon("x")}</button>
    </div>`).join("")}
  <main class="conteudo">${conteudo}</main>`;

  $("#sair").addEventListener("click", async () => { await api.sair(); estado.perfil = null; location.hash = "#/"; });
  $("#resetDemo")?.addEventListener("click", () => { api.reset(); estado.perfil = null; location.reload(); });
  $$("[data-fecha-banner]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.fechaBanner;
    const fechados = JSON.parse(storage.get("portalbi_banners") || "[]");
    storage.set("portalbi_banners", JSON.stringify([...fechados, id]));
    b.closest(".banner").remove();
  }));
}

async function bannersVigentes() {
  const fechados = JSON.parse(storage.get("portalbi_banners") || "[]");
  const agora = new Date();
  return (await api.avisos()).filter((a) =>
    a.tipo === "banner" && a.ativo && new Date(a.inicio) <= agora && (!a.fim || new Date(a.fim) > agora)
    && !fechados.includes(String(a.id)));
}

// =====================================================================
// INÍCIO
// =====================================================================
async function telaInicio() {
  const [dashs, cats, avisos] = await Promise.all([api.dashboards(), api.categorias(), api.avisos()]);
  const agora = new Date();
  const mural = avisos.filter((a) => a.tipo === "mural" && a.ativo && new Date(a.inicio) <= agora && (!a.fim || new Date(a.fim) > agora));
  const visiveis = dashs.filter((d) => d.ativo);
  const p = estado.perfil;

  const grupos = [...cats, { id: null, nome: "Outros" }]
    .map((c) => ({ ...c, itens: visiveis.filter((d) => (d.categoria_id ?? null) === c.id) }))
    .filter((g) => g.itens.length);

  const atrasados = visiveis.filter((d) => !ehSistema(d) && statusAtualizacao(d).cls === "atrasado").length;

  await shell(`
    <section class="ola">
      <div>
        <h1>${saudacao()}, ${esc(p.nome.split(" ")[0])}</h1>
        <p class="muted">${visiveis.length} ${visiveis.length === 1 ? "painel disponível" : "painéis disponíveis"} para você${atrasados ? ` · <span class="txt-alerta">${atrasados} com atualização atrasada</span>` : ""}</p>
      </div>
      <label class="busca">${icon("search")}<input type="search" id="busca" placeholder="Buscar painel…" aria-label="Buscar painel"></label>
    </section>

    ${mural.length ? `
    <section class="secao">
      <div class="secao-h"><h2>${icon("megaphone")} Mural de avisos</h2><a href="#/avisos" class="link">Ver todos</a></div>
      <div class="mural">${mural.slice(0, 3).map(cardAviso).join("")}</div>
    </section>` : ""}

    ${grupos.length ? grupos.map((g) => `
      <section class="secao grupo" data-grupo>
        <div class="secao-h"><h2>${icon("folder")} ${esc(g.nome)}</h2><span class="muted">${g.itens.length}</span></div>
        <div class="grade">${g.itens.map(cardDashboard).join("")}</div>
      </section>`).join("") : `
      <div class="vazio">${icon("chart")}<h3>Nenhum painel liberado ainda</h3>
        <p>${p.is_admin ? "Cadastre o primeiro painel em Administração." : "Peça à equipe de BI para liberar os painéis que você precisa."}</p>
        ${p.is_admin ? `<a class="btn btn-primary" href="#/admin/dashboards">${icon("plus")} Cadastrar painel</a>` : ""}
      </div>`}
    <div class="vazio oculto" id="semResultado">${icon("search")}<h3>Nenhum painel encontrado</h3></div>
  `, { ativo: "inicio" });

  $("#busca")?.addEventListener("input", (e) => {
    const t = e.target.value.trim().toLowerCase();
    let total = 0;
    $$("[data-grupo]").forEach((g) => {
      let n = 0;
      $$(".card-dash", g).forEach((c) => {
        const ok = !t || c.dataset.busca.includes(t);
        c.classList.toggle("oculto", !ok);
        n += ok;
      });
      g.classList.toggle("oculto", !n);
      total += n;
    });
    $("#semResultado").classList.toggle("oculto", total > 0);
  });
}

function cardDashboard(d) {
  const sistema = ehSistema(d);
  const st = sistema ? { cls: "neutro", texto: "Sistema integrado" } : statusAtualizacao(d);
  return `
  <a class="card-dash ${d.ativo ? "" : "inativo"}" href="#/d/${d.id}" data-busca="${esc((d.titulo + " " + (d.descricao ?? "")).toLowerCase())}">
    <div class="card-dash-topo">
      <span class="card-ic">${icon(sistema ? "grid" : "chart")}</span>
      ${d.nota ? `<span class="tag tag-${esc(d.nota_tipo)}" title="${esc(d.nota)}">${icon(NIVEL_ICON[d.nota_tipo])}${d.nota_tipo === "info" ? "Novidade" : "Atenção"}</span>` : ""}
    </div>
    <h3>${esc(d.titulo)}</h3>
    <p>${esc(d.descricao ?? "")}</p>
    <div class="status status-${st.cls}">${icon(sistema ? "grid" : "clock")}<span>${esc(st.texto)}</span></div>
  </a>`;
}

function cardAviso(a) {
  return `
  <article class="aviso aviso-${esc(a.nivel)}">
    ${a.imagem_url ? `<img src="${esc(a.imagem_url)}" alt="" loading="lazy">` : ""}
    <div class="aviso-corpo">
      <div class="aviso-meta">${icon(NIVEL_ICON[a.nivel])}<span>${esc(dataBR(a.inicio))}</span></div>
      <h3>${esc(a.titulo)}</h3>
      ${a.conteudo ? `<p>${esc(a.conteudo).replace(/\n/g, "<br>")}</p>` : ""}
      ${a.link ? `<a class="link" href="${esc(a.link)}" target="_blank" rel="noopener">Saiba mais ${icon("external")}</a>` : ""}
    </div>
  </article>`;
}

async function telaAvisos() {
  const agora = new Date();
  const lista = (await api.avisos()).filter((a) => a.tipo === "mural" && a.ativo && new Date(a.inicio) <= agora && (!a.fim || new Date(a.fim) > agora));
  await shell(`
    <section class="ola"><div><h1>Mural de avisos</h1><p class="muted">Comunicados da equipe de BI.</p></div></section>
    ${lista.length ? `<div class="mural mural-lista">${lista.map(cardAviso).join("")}</div>`
      : `<div class="vazio">${icon("megaphone")}<h3>Nenhum aviso no momento</h3></div>`}
  `, { ativo: "avisos" });
}

// =====================================================================
// VISUALIZADOR DO DASHBOARD
// =====================================================================
async function telaDashboard(id) {
  const d = await api.dashboard(id);
  if (!d) {
    return shell(`<div class="vazio">${icon("lock")}<h3>Painel indisponível</h3>
      <p>Você não tem acesso a este painel ou ele foi removido.</p><a class="btn" href="#/">Voltar ao início</a></div>`);
  }
  const st = statusAtualizacao(d);
  const demo = d.link.startsWith("demo:");
  const sistema = ehSistema(d);
  await shell(`
    <div class="visor">
      <div class="visor-barra">
        <a class="btn-icon" href="#/" title="Voltar" aria-label="Voltar">${icon("back")}</a>
        <div class="visor-titulo">
          <h1>${esc(d.titulo)}</h1>
          ${sistema ? "" : `<div class="status status-${st.cls}">${icon("clock")}<span>${esc(st.texto)}</span>
            ${d.atualizado_em ? `<span class="muted">· ${esc(dataHoraBR(d.atualizado_em))} · ${esc(FREQ_LABEL[d.frequencia])}</span>` : ""}</div>`}
        </div>
        <div class="visor-acoes">
          <button class="btn btn-ghost" id="telaCheia">${icon("expand")}<span>Tela cheia</span></button>
          ${demo ? "" : `<a class="btn btn-ghost" href="${esc(d.link)}" target="_blank" rel="noopener">${icon("external")}<span>Nova aba</span></a>`}
        </div>
      </div>
      ${d.nota ? `<div class="nota nota-${esc(d.nota_tipo)}">${icon(NIVEL_ICON[d.nota_tipo])}<span>${esc(d.nota)}</span></div>` : ""}
      <div class="visor-frame" id="frame">
        <iframe title="${esc(d.titulo)}" ${demo ? `srcdoc="${esc(demoRelatorio(d))}"` : `src="${esc(d.link)}"`}
          allowfullscreen loading="eager"></iframe>
      </div>
    </div>`, { banner: false, cheio: true, ativo: sistema ? `d${d.id}` : "" });

  $("#telaCheia").addEventListener("click", () => {
    const el = $("#frame");
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  });
}

// Simula um relatório no modo demonstração
function demoRelatorio(d) {
  const barras = Array.from({ length: 12 }, (_, i) => 30 + Math.round(Math.abs(Math.sin(i * 1.7 + d.id)) * 60));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:system-ui,sans-serif;background:#f3f5f8;color:#1d2433;display:flex;flex-direction:column;height:100vh}
    header{background:#fff;padding:14px 20px;border-bottom:1px solid #e3e7ee;font-weight:600}
    .g{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:16px 20px}
    .k{background:#fff;border-radius:8px;padding:14px;border:1px solid #e3e7ee}.k b{display:block;font-size:24px;margin-top:4px}
    .k span{font-size:12px;color:#5b6577}.c{flex:1;margin:0 20px 20px;background:#fff;border-radius:8px;border:1px solid #e3e7ee;display:flex;align-items:flex-end;gap:2%;padding:20px 20px 30px;position:relative}
    .c i{flex:1;background:#2d6a4f;border-radius:3px 3px 0 0}.c p{position:absolute;top:10px;left:20px;margin:0;font-size:13px;color:#5b6577}
  </style></head><body><header>${esc(d.titulo)} <small style="color:#8a93a3;font-weight:400">· relatório de demonstração</small></header>
  <div class="g">${["Receita", "Meta", "Realizado", "Variação"].map((k, i) => `<div class="k"><span>${k}</span><b>${["R$ 4,8 mi", "R$ 5,1 mi", "94%", "+6,2%"][i]}</b></div>`).join("")}</div>
  <div class="c"><p>Evolução mensal</p>${barras.map((b) => `<i style="height:${b}%"></i>`).join("")}</div>
  </body></html>`;
}

// =====================================================================
// ADMINISTRAÇÃO
// =====================================================================
const ABAS = [
  ["dashboards", "Painéis", "chart"],
  ["categorias", "Categorias", "folder"],
  ["usuarios", "Usuários", "users"],
  ["avisos", "Avisos", "megaphone"],
];

async function telaAdmin(aba) {
  const render = { dashboards: adminDashboards, categorias: adminCategorias, usuarios: adminUsuarios, avisos: adminAvisos }[aba];
  if (!render) { location.hash = "#/admin/dashboards"; return; }
  const corpo = await render();
  await shell(`
    <section class="ola"><div><h1>Administração</h1><p class="muted">Gerencie painéis, acessos e comunicados.</p></div></section>
    <nav class="abas" role="tablist">
      ${ABAS.map(([k, t, ic]) => `<a role="tab" href="#/admin/${k}" class="${k === aba ? "on" : ""}" aria-selected="${k === aba}">${icon(ic)}${t}</a>`).join("")}
    </nav>
    <div class="admin-corpo">${corpo.html}</div>`, { ativo: "admin", banner: false });
  corpo.bind?.();
}

const recarregar = () => { estado.sistemas = null; return rota(); };

// ---------------------------------------------------------------- painéis
async function adminDashboards() {
  const [dashs, cats, acessos] = await Promise.all([api.dashboards(), api.categorias(), api.contagemAcessos()]);
  const nomeCat = (id) => cats.find((c) => c.id === id)?.nome ?? "—";
  const qtd = (id) => acessos.filter((a) => a.dashboard_id === id).length;

  return {
    html: `
    <div class="barra-acoes">
      <label class="busca">${icon("search")}<input type="search" id="filtro" placeholder="Filtrar painéis…"></label>
      <button class="btn btn-primary" id="novo">${icon("plus")} Novo painel</button>
    </div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Painel</th><th>Categoria</th><th>Atualização</th><th>Usuários</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${dashs.length ? dashs.map((d) => {
        const st = statusAtualizacao(d);
        return `<tr data-busca="${esc((d.titulo + " " + nomeCat(d.categoria_id)).toLowerCase())}">
          <td><strong>${esc(d.titulo)}</strong>${d.nota ? `<div class="sub tag-txt-${esc(d.nota_tipo)}">${icon(NIVEL_ICON[d.nota_tipo])}${esc(d.nota)}</div>` : ""}</td>
          <td>${esc(nomeCat(d.categoria_id))}</td>
          <td><span class="status status-${st.cls}">${icon("clock")}${esc(d.atualizado_em ? tempoRelativo(d.atualizado_em) : "—")}</span><div class="sub">${esc(FREQ_LABEL[d.frequencia])}</div></td>
          <td>${qtd(d.id)}</td>
          <td>${d.ativo ? `<span class="pill pill-ok">Ativo</span>` : `<span class="pill">Inativo</span>`}</td>
          <td class="acoes">
            <button class="btn-icon" data-atualizado="${d.id}" title="Marcar como atualizado agora" aria-label="Marcar como atualizado agora">${icon("refresh")}</button>
            <button class="btn-icon" data-editar="${d.id}" title="Editar" aria-label="Editar">${icon("edit")}</button>
            <button class="btn-icon perigo" data-excluir="${d.id}" title="Excluir" aria-label="Excluir">${icon("trash")}</button>
          </td></tr>`;
      }).join("") : `<tr><td colspan="6" class="vazio-td">Nenhum painel cadastrado.</td></tr>`}
      </tbody></table></div>`,
    bind() {
      filtroTabela();
      $("#novo").addEventListener("click", () => formDashboard(null, cats));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => formDashboard(dashs.find((d) => d.id === Number(b.dataset.editar)), cats)));
      $$("[data-atualizado]").forEach((b) => b.addEventListener("click", async () => {
        try { await api.marcarAtualizado(Number(b.dataset.atualizado)); toast("Atualização registrada."); recarregar(); }
        catch (e) { toast(e.message, "erro"); }
      }));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const d = dashs.find((x) => x.id === Number(b.dataset.excluir));
        if (!(await confirmar("Excluir painel", `O painel <strong>${esc(d.titulo)}</strong> e todos os acessos a ele serão removidos.`))) return;
        try { await api.excluirDashboard(d.id); toast("Painel excluído."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

async function formDashboard(d, cats) {
  const novo = !d;
  d = d ?? { titulo: "", descricao: "", link: "", categoria_id: cats[0]?.id ?? null, frequencia: "diaria", nota: "", nota_tipo: "info", atualizado_em: null, ativo: true, ordem: 0 };
  const [usuarios, liberados] = await Promise.all([api.usuarios(), novo ? [] : api.acessosDoDashboard(d.id)]);
  const comuns = usuarios.filter((u) => !u.is_admin);

  modal({
    titulo: novo ? "Novo painel" : "Editar painel",
    largura: "modal-lg",
    corpo: `
    <div class="form-grid">
      <label class="campo col-2"><span>Título *</span><input name="titulo" required maxlength="120" value="${esc(d.titulo)}"></label>
      <label class="campo"><span>Categoria</span><select name="categoria_id">
        <option value="">Sem categoria</option>
        ${cats.map((c) => `<option value="${c.id}" ${c.id === d.categoria_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}
      </select></label>
      <label class="campo"><span>Ordem</span><input type="number" name="ordem" value="${esc(d.ordem)}"></label>
      <label class="campo col-2"><span>Link de incorporação do Power BI *</span>
        <input type="url" name="link" required placeholder="https://app.powerbi.com/view?r=…" value="${esc(d.link)}">
        <small class="dica">No Power BI: Arquivo › Inserir relatório › Site ou portal (ou Publicar na Web).
          Um link de ${esc(location.origin)} (ex.: o Informativo) vira sistema integrado: abre com o mesmo login e aparece no menu do topo.</small></label>
      <label class="campo col-2"><span>Descrição</span><textarea name="descricao" rows="2" maxlength="500">${esc(d.descricao ?? "")}</textarea></label>

      <fieldset class="col-2 grupo-campos"><legend>${icon("clock")} Status de atualização</legend>
        <div class="form-grid">
          <label class="campo"><span>Frequência esperada</span><select name="frequencia">
            ${Object.entries(FREQ_LABEL).map(([k, v]) => `<option value="${k}" ${k === d.frequencia ? "selected" : ""}>${v}</option>`).join("")}
          </select></label>
          <label class="campo"><span>Última atualização dos dados</span>
            <div class="input-btn"><input type="datetime-local" name="atualizado_em" value="${toLocalInput(d.atualizado_em)}">
            <button type="button" class="btn btn-ghost" id="agora">Agora</button></div></label>
        </div>
      </fieldset>

      <fieldset class="col-2 grupo-campos"><legend>${icon("info")} Nota do painel</legend>
        <div class="form-grid">
          <label class="campo col-2"><span>Texto exibido no painel (opcional)</span>
            <input name="nota" maxlength="200" placeholder="Ex.: Dados de setembro em validação" value="${esc(d.nota ?? "")}"></label>
          <label class="campo"><span>Tipo</span><select name="nota_tipo">
            <option value="info" ${d.nota_tipo === "info" ? "selected" : ""}>Informação / novidade</option>
            <option value="alerta" ${d.nota_tipo === "alerta" ? "selected" : ""}>Alerta</option>
            <option value="critico" ${d.nota_tipo === "critico" ? "selected" : ""}>Crítico</option>
          </select></label>
          <label class="switch"><input type="checkbox" name="ativo" ${d.ativo ? "checked" : ""}><span></span>Painel ativo</label>
        </div>
      </fieldset>

      <fieldset class="col-2 grupo-campos"><legend>${icon("users")} Quem pode ver</legend>
        <p class="dica">Administradores veem todos os painéis automaticamente.</p>
        ${checklist("usuarios", comuns.map((u) => ({ v: u.id, t: u.nome || u.email, s: u.email, on: liberados.includes(u.id) })), "Nenhum usuário comum cadastrado.")}
      </fieldset>
    </div>`,
    onOpen(f) {
      $("#agora", f).addEventListener("click", () => { f.atualizado_em.value = toLocalInput(new Date().toISOString()); });
      bindChecklist(f);
    },
    async onSubmit(f) {
      const titulo = f.titulo.value.trim();
      const link = f.link.value.trim();
      if (!titulo) throw new Error("Informe o título.");
      if (!/^https:\/\//i.test(link) && !link.startsWith("demo:")) throw new Error("O link deve começar com https://");
      const dados = {
        titulo, link,
        id: d.id,
        categoria_id: f.categoria_id.value ? Number(f.categoria_id.value) : null,
        ordem: Number(f.ordem.value) || 0,
        descricao: f.descricao.value.trim() || null,
        frequencia: f.frequencia.value,
        atualizado_em: fromLocalInput(f.atualizado_em.value),
        nota: f.nota.value.trim() || null,
        nota_tipo: f.nota_tipo.value,
        ativo: f.ativo.checked,
      };
      if (novo) delete dados.id;
      const usuariosSel = $$('input[name="usuarios"]:checked', f).map((c) => c.value);
      await api.salvarDashboard(dados, usuariosSel);
      toast(novo ? "Painel cadastrado." : "Painel atualizado.");
      recarregar();
    },
  });
}

// ---------------------------------------------------------------- categorias
async function adminCategorias() {
  const [cats, dashs] = await Promise.all([api.categorias(), api.dashboards()]);
  const qtd = (id) => dashs.filter((d) => d.categoria_id === id).length;
  return {
    html: `
    <div class="barra-acoes"><span></span><button class="btn btn-primary" id="novo">${icon("plus")} Nova categoria</button></div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Categoria</th><th>Ordem</th><th>Painéis</th><th></th></tr></thead>
      <tbody>${cats.length ? cats.map((c) => `
        <tr><td><strong>${esc(c.nome)}</strong></td><td>${c.ordem}</td><td>${qtd(c.id)}</td>
        <td class="acoes">
          <button class="btn-icon" data-editar="${c.id}" aria-label="Editar">${icon("edit")}</button>
          <button class="btn-icon perigo" data-excluir="${c.id}" aria-label="Excluir">${icon("trash")}</button>
        </td></tr>`).join("") : `<tr><td colspan="4" class="vazio-td">Nenhuma categoria.</td></tr>`}
      </tbody></table></div>`,
    bind() {
      const form = (c) => modal({
        titulo: c ? "Editar categoria" : "Nova categoria",
        corpo: `<div class="form-grid">
          <label class="campo col-2"><span>Nome *</span><input name="nome" required maxlength="60" value="${esc(c?.nome ?? "")}"></label>
          <label class="campo"><span>Ordem de exibição</span><input type="number" name="ordem" value="${c?.ordem ?? cats.length + 1}"></label></div>`,
        async onSubmit(f) {
          if (!f.nome.value.trim()) throw new Error("Informe o nome.");
          await api.salvarCategoria({ ...(c ? { id: c.id } : {}), nome: f.nome.value.trim(), ordem: Number(f.ordem.value) || 0 });
          toast("Categoria salva."); recarregar();
        },
      });
      $("#novo").addEventListener("click", () => form(null));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => form(cats.find((c) => c.id === Number(b.dataset.editar)))));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const c = cats.find((x) => x.id === Number(b.dataset.excluir));
        const n = qtd(c.id);
        if (!(await confirmar("Excluir categoria", `Excluir <strong>${esc(c.nome)}</strong>?${n ? ` Os ${n} painéis dela ficarão em "Outros".` : ""}`))) return;
        try { await api.excluirCategoria(c.id); toast("Categoria excluída."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

// ---------------------------------------------------------------- usuários
async function adminUsuarios() {
  const [usuarios, dashs, cats, acessos] = await Promise.all([api.usuarios(), api.dashboards(), api.categorias(), api.contagemAcessos()]);
  const qtd = (uid) => acessos.filter((a) => a.user_id === uid).length;
  const situacao = (u) => !u.ativo ? `<span class="pill">Inativo</span>`
    : u.confirmado === false ? `<span class="pill pill-alerta">Convite pendente</span>`
    : `<span class="pill pill-ok">Ativo</span>`;

  return {
    html: `
    <div class="barra-acoes">
      <label class="busca">${icon("search")}<input type="search" id="filtro" placeholder="Filtrar usuários…"></label>
      <button class="btn btn-primary" id="novo">${icon("plus")} Convidar usuário</button>
    </div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Usuário</th><th>Perfil</th><th>Painéis</th><th>Último acesso</th><th>Situação</th><th></th></tr></thead>
      <tbody>${usuarios.map((u) => `
        <tr data-busca="${esc((u.nome + " " + u.email).toLowerCase())}">
          <td><div class="user-cel"><span class="avatar sm">${esc(iniciais(u.nome))}</span><div><strong>${esc(u.nome || "—")}</strong><div class="sub">${esc(u.email)}</div></div></div></td>
          <td>${u.is_admin ? `<span class="pill pill-adm">Administrador</span>` : "Usuário"}</td>
          <td>${u.is_admin ? "Todos" : qtd(u.id)}</td>
          <td>${u.ultimo_acesso ? esc(tempoRelativo(u.ultimo_acesso)) : `<span class="muted">Nunca</span>`}</td>
          <td>${situacao(u)}</td>
          <td class="acoes">
            <button class="btn-icon" data-reenviar="${u.id}" title="${u.confirmado === false ? "Reenviar convite" : "Enviar link de nova senha"}" aria-label="Reenviar e-mail">${icon("mail")}</button>
            <button class="btn-icon" data-editar="${u.id}" title="Editar" aria-label="Editar">${icon("edit")}</button>
            ${u.id !== estado.perfil.id ? `<button class="btn-icon perigo" data-excluir="${u.id}" title="Excluir" aria-label="Excluir">${icon("trash")}</button>` : `<span class="btn-icon-vazio"></span>`}
          </td></tr>`).join("")}
      </tbody></table></div>`,
    bind() {
      filtroTabela();
      $("#novo").addEventListener("click", () => formUsuario(null, dashs, cats));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => formUsuario(usuarios.find((u) => u.id === b.dataset.editar), dashs, cats)));
      $$("[data-reenviar]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const r = await api.reenviarConvite(b.dataset.reenviar);
          toast(r?.tipo === "senha" ? "Link de nova senha enviado." : "Convite reenviado.");
        } catch (e) { toast(e.message, "erro"); } finally { b.disabled = false; }
      }));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const u = usuarios.find((x) => x.id === b.dataset.excluir);
        if (!(await confirmar("Excluir usuário", `<strong>${esc(u.nome)}</strong> perderá o acesso ao portal (o login dele em outros sistemas não é afetado). Para bloquear temporariamente, prefira desativar.`))) return;
        try { await api.excluirUsuario(u.id); toast("Usuário excluído."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

async function formUsuario(u, dashs, cats) {
  const novo = !u;
  const liberados = novo ? [] : await api.acessosDoUsuario(u.id);
  const eu = u?.id === estado.perfil.id;
  const opcoes = [...cats, { id: null, nome: "Outros" }].flatMap((c) =>
    dashs.filter((d) => (d.categoria_id ?? null) === c.id).map((d) => ({ v: d.id, t: d.titulo, s: c.nome, on: liberados.includes(d.id) })));

  modal({
    titulo: novo ? "Convidar usuário" : "Editar usuário",
    botao: novo ? "Enviar convite" : "Salvar",
    largura: "modal-lg",
    corpo: `
    <div class="form-grid">
      <label class="campo"><span>Nome *</span><input name="nome" required maxlength="120" value="${esc(u?.nome ?? "")}"></label>
      <label class="campo"><span>E-mail *</span><input type="email" name="email" required value="${esc(u?.email ?? "")}" ${novo ? "" : "disabled"}></label>
      <label class="switch"><input type="checkbox" name="is_admin" ${u?.is_admin ? "checked" : ""} ${eu ? "disabled" : ""}><span></span>Administrador</label>
      ${novo ? "" : `<label class="switch"><input type="checkbox" name="ativo" ${u.ativo ? "checked" : ""} ${eu ? "disabled" : ""}><span></span>Acesso ativo</label>`}
      ${novo ? `<p class="dica col-2">${icon("mail")} O usuário receberá um e-mail para definir a própria senha.</p>` : ""}
      <fieldset class="col-2 grupo-campos" id="gDash"><legend>${icon("chart")} Painéis liberados</legend>
        <p class="dica adm-dica">Administradores veem todos os painéis.</p>
        ${checklist("dashs", opcoes, "Nenhum painel cadastrado.")}
      </fieldset>
    </div>`,
    onOpen(f) {
      bindChecklist(f);
      const sync = () => $("#gDash", f).classList.toggle("desabilitado", f.is_admin.checked);
      f.is_admin.addEventListener("change", sync); sync();
    },
    async onSubmit(f) {
      const nome = f.nome.value.trim();
      if (!nome) throw new Error("Informe o nome.");
      const dashboards = $$('input[name="dashs"]:checked', f).map((c) => Number(c.value));
      if (novo) {
        const email = f.email.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("E-mail inválido.");
        const r = await api.convidarUsuario({ nome, email, is_admin: f.is_admin.checked, dashboards });
        toast(r?.ja_tinha_login
          ? `${email} já tinha login: acesso liberado, ele entra com a senha que já usa.`
          : `Convite enviado para ${email}.`);
      } else {
        await api.salvarUsuario({ id: u.id, nome, is_admin: eu ? u.is_admin : f.is_admin.checked, ativo: eu ? true : f.ativo.checked }, dashboards);
        toast("Usuário atualizado.");
        if (eu) estado.perfil = null;
      }
      recarregar();
    },
  });
}

// ---------------------------------------------------------------- avisos
async function adminAvisos() {
  const avisos = await api.avisos();
  const agora = new Date();
  const situacao = (a) => !a.ativo ? ["Inativo", ""]
    : new Date(a.inicio) > agora ? ["Agendado", "pill-alerta"]
    : a.fim && new Date(a.fim) <= agora ? ["Expirado", ""]
    : ["No ar", "pill-ok"];
  return {
    html: `
    <div class="barra-acoes"><span class="muted">Banners aparecem no topo de todas as páginas; avisos do mural aparecem no início.</span>
      <button class="btn btn-primary" id="novo">${icon("plus")} Novo aviso</button></div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Aviso</th><th>Tipo</th><th>Período</th><th>Situação</th><th></th></tr></thead>
      <tbody>${avisos.length ? avisos.map((a) => {
        const [s, c] = situacao(a);
        return `<tr>
          <td><div class="aviso-cel tag-txt-${esc(a.nivel)}">${icon(NIVEL_ICON[a.nivel])}<div><strong>${esc(a.titulo)}</strong><div class="sub">${esc((a.conteudo ?? "").slice(0, 90))}</div></div></div></td>
          <td>${a.tipo === "banner" ? "Banner" : "Mural"}</td>
          <td class="nowrap">${esc(dataBR(a.inicio))} → ${a.fim ? esc(dataBR(a.fim)) : "sem fim"}</td>
          <td><span class="pill ${c}">${s}</span></td>
          <td class="acoes">
            <button class="btn-icon" data-editar="${a.id}" aria-label="Editar">${icon("edit")}</button>
            <button class="btn-icon perigo" data-excluir="${a.id}" aria-label="Excluir">${icon("trash")}</button>
          </td></tr>`;
      }).join("") : `<tr><td colspan="5" class="vazio-td">Nenhum aviso cadastrado.</td></tr>`}
      </tbody></table></div>`,
    bind() {
      $("#novo").addEventListener("click", () => formAviso(null));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => formAviso(avisos.find((a) => a.id === Number(b.dataset.editar)))));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const a = avisos.find((x) => x.id === Number(b.dataset.excluir));
        if (!(await confirmar("Excluir aviso", `Excluir <strong>${esc(a.titulo)}</strong>?`))) return;
        try { await api.excluirAviso(a.id); toast("Aviso excluído."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

function formAviso(a) {
  const novo = !a;
  a = a ?? { tipo: "mural", nivel: "info", titulo: "", conteudo: "", imagem_url: null, link: "", inicio: new Date().toISOString(), fim: null, ativo: true };
  let imagem = a.imagem_url;
  modal({
    titulo: novo ? "Novo aviso" : "Editar aviso",
    largura: "modal-lg",
    corpo: `
    <div class="form-grid">
      <label class="campo"><span>Onde exibir</span><select name="tipo">
        <option value="mural" ${a.tipo === "mural" ? "selected" : ""}>Mural de avisos (página inicial)</option>
        <option value="banner" ${a.tipo === "banner" ? "selected" : ""}>Banner de destaque (topo)</option></select></label>
      <label class="campo"><span>Nível</span><select name="nivel">
        <option value="info" ${a.nivel === "info" ? "selected" : ""}>Informativo</option>
        <option value="alerta" ${a.nivel === "alerta" ? "selected" : ""}>Alerta</option>
        <option value="critico" ${a.nivel === "critico" ? "selected" : ""}>Crítico</option></select></label>
      <label class="campo col-2"><span>Título *</span><input name="titulo" required maxlength="120" value="${esc(a.titulo)}"></label>
      <label class="campo col-2"><span>Texto</span><textarea name="conteudo" rows="4" maxlength="1000">${esc(a.conteudo ?? "")}</textarea></label>
      <label class="campo col-2"><span>Link "Saiba mais" (opcional)</span><input type="url" name="link" placeholder="https://…" value="${esc(a.link ?? "")}"></label>
      <div class="campo col-2" id="campoImg"><span>Imagem (somente mural)</span>
        <div class="img-up">
          <div class="img-prev" id="prev">${imagem ? `<img src="${esc(imagem)}" alt="">` : icon("image")}</div>
          <div><input type="file" accept="image/png,image/jpeg,image/webp" id="arq">
          <button type="button" class="link ${imagem ? "" : "oculto"}" id="remImg">Remover imagem</button>
          <p class="dica">PNG, JPG ou WEBP até 2 MB.</p></div>
        </div></div>
      <label class="campo"><span>Início</span><input type="datetime-local" name="inicio" value="${toLocalInput(a.inicio)}"></label>
      <label class="campo"><span>Fim (opcional)</span><input type="datetime-local" name="fim" value="${toLocalInput(a.fim)}"></label>
      <label class="switch"><input type="checkbox" name="ativo" ${a.ativo ? "checked" : ""}><span></span>Ativo</label>
    </div>`,
    onOpen(f) {
      const sync = () => $("#campoImg", f).classList.toggle("oculto", f.tipo.value !== "mural");
      f.tipo.addEventListener("change", sync); sync();
      $("#arq", f).addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { toast("Imagem maior que 2 MB.", "erro"); e.target.value = ""; return; }
        try {
          $("#prev", f).classList.add("loading");
          imagem = await api.enviarImagem(file);
          $("#prev", f).innerHTML = `<img src="${esc(imagem)}" alt="">`;
          $("#remImg", f).classList.remove("oculto");
        } catch (err) { toast(err.message, "erro"); } finally { $("#prev", f).classList.remove("loading"); }
      });
      $("#remImg", f).addEventListener("click", () => { imagem = null; $("#prev", f).innerHTML = icon("image"); $("#remImg", f).classList.add("oculto"); $("#arq", f).value = ""; });
    },
    async onSubmit(f) {
      if (!f.titulo.value.trim()) throw new Error("Informe o título.");
      const inicio = fromLocalInput(f.inicio.value) ?? new Date().toISOString();
      const fim = fromLocalInput(f.fim.value);
      if (fim && fim <= inicio) throw new Error("O fim deve ser depois do início.");
      const link = f.link.value.trim();
      if (link && !/^https?:\/\//i.test(link)) throw new Error("O link deve começar com http:// ou https://");
      await api.salvarAviso({
        ...(novo ? {} : { id: a.id }),
        tipo: f.tipo.value, nivel: f.nivel.value, titulo: f.titulo.value.trim(),
        conteudo: f.conteudo.value.trim() || null, link: link || null,
        imagem_url: f.tipo.value === "mural" ? imagem : null,
        inicio, fim, ativo: f.ativo.checked,
      });
      toast("Aviso salvo."); recarregar();
    },
  });
}

// ---------------------------------------------------------------- helpers admin
function checklist(nome, itens, vazio) {
  if (!itens.length) return `<p class="muted">${vazio}</p>`;
  return `
  <div class="check-ferr">
    <label class="busca sm">${icon("search")}<input type="search" data-check-busca placeholder="Filtrar…"></label>
    <span class="muted" data-check-cont></span>
    <button type="button" class="link" data-check-todos>Marcar todos</button>
    <button type="button" class="link" data-check-nenhum>Limpar</button>
  </div>
  <div class="check-lista">
    ${itens.map((i) => `
      <label class="check" data-txt="${esc((i.t + " " + (i.s ?? "")).toLowerCase())}">
        <input type="checkbox" name="${nome}" value="${esc(i.v)}" ${i.on ? "checked" : ""}>
        <span><strong>${esc(i.t)}</strong>${i.s ? `<small>${esc(i.s)}</small>` : ""}</span>
      </label>`).join("")}
  </div>`;
}

function bindChecklist(root) {
  const cont = $("[data-check-cont]", root);
  if (!cont) return;
  const caixas = () => $$(".check-lista input[type=checkbox]", root);
  const conta = () => { cont.textContent = `${caixas().filter((c) => c.checked).length} de ${caixas().length} selecionados`; };
  conta();
  root.addEventListener("change", (e) => e.target.matches(".check-lista input") && conta());
  $("[data-check-busca]", root).addEventListener("input", (e) => {
    const t = e.target.value.toLowerCase();
    $$(".check", root).forEach((l) => l.classList.toggle("oculto", !l.dataset.txt.includes(t)));
  });
  const marcar = (v) => { caixas().forEach((c) => { if (!c.closest(".check").classList.contains("oculto")) c.checked = v; }); conta(); };
  $("[data-check-todos]", root).addEventListener("click", () => marcar(true));
  $("[data-check-nenhum]", root).addEventListener("click", () => marcar(false));
}

function filtroTabela() {
  $("#filtro")?.addEventListener("input", (e) => {
    const t = e.target.value.toLowerCase();
    $$(".tabela tbody tr[data-busca]").forEach((tr) => tr.classList.toggle("oculto", !tr.dataset.busca.includes(t)));
  });
}

iniciar();
