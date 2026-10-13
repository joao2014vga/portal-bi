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

// Sempre carrega a versão mais recente do sistema integrado (o GitHub Pages
// guarda a página em cache por alguns minutos e o Ctrl+F5 não alcança o iframe)
function semCache(link) {
  const u = new URL(link);
  u.searchParams.set("v", Date.now());
  return u.href;
}

document.title = CONFIG.NOME_PORTAL;

// =====================================================================
// INICIALIZAÇÃO E ROTAS
// =====================================================================
async function iniciar() {
  if (!location.hash.startsWith("#/")) history.replaceState(null, "", location.pathname + location.search + "#/");

  api.onAuth(async (evt) => {
    if (evt === "PASSWORD_RECOVERY") { estado.precisaSenha = "recovery"; rota(); }
    if (evt === "SIGNED_OUT") { estado.perfil = null; estado.precisaSenha = null; rota(); }
  });

  if (ERRO_URL) toast(ERRO_URL.includes("expired") ? "This link has expired. Please request a new one from the administrator." : ERRO_URL, "erro");
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
    if (!estado.perfil) { await api.sair(); return telaLogin("Profile not found. Please contact the administrator."); }
    if (!estado.perfil.ativo) { await api.sair(); return telaLogin("Your access has been deactivated. Please contact the administrator."); }
  }
  // senha provisória definida pelo administrador: troca obrigatória antes de usar o portal
  if (!estado.precisaSenha && sessao.user?.user_metadata?.trocar_senha) estado.precisaSenha = "provisoria";
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
    shell(`<div class="vazio">${icon("alert")}<h3>Unable to load this page</h3><p>${esc(e.message)}</p></div>`);
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
        <span class="login-eyebrow">${esc(CONFIG.NOME_EMPRESA)} · Business Intelligence</span>
        <h1>Corporate Reporting Portal</h1>
        <p>Centralized access to management reports, key performance indicators and corporate communications.</p>
      </div>
      <p class="login-rodape">© ${new Date().getFullYear()} ${esc(CONFIG.NOME_EMPRESA)}. Restricted access — authorized personnel only.</p>
    </section>

    <section class="login-form-wrap">
      <form class="login-form" id="fLogin" novalidate>
        <span class="logo login-logo"><img src="assets/logo_brascof.png" alt="${esc(CONFIG.NOME_EMPRESA)}"></span>
        <h2>Sign in</h2>
        <p class="muted">Use the e-mail address registered by the BI team.</p>
        ${msg ? `<div class="aviso-inline alerta">${icon("alert")}<span>${esc(msg)}</span></div>` : ""}
        <label class="campo"><span>E-mail</span>
          <input type="email" name="email" autocomplete="username" required placeholder="name@company.com"></label>
        <label class="campo"><span>Password</span>
          <input type="password" name="senha" autocomplete="current-password" required placeholder="••••••••"></label>
        <p class="form-erro" aria-live="polite"></p>
        <button class="btn btn-primary btn-bloco" type="submit">Sign in</button>
        <button class="link" type="button" id="esqueci">Forgot your password?</button>
        ${MODO_DEMO ? `
          <div class="demo-box">
            <strong>Demo mode</strong>
            <p>Admin: <code>admin@demo.com</code> · User: <code>mariana@demo.com</code><br>Password: <code>demo1234</code></p>
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
    if (!f.email.value || !f.senha.value) { erro.textContent = "Please enter your e-mail and password."; return; }
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
    // sem envio de e-mail: o administrador define uma senha provisória
    modal({
      titulo: "Forgot your password?",
      corpo: `<p>Please contact the portal administrator. They will set a temporary password for you,
        which you will be asked to change at your next sign-in.</p>`,
    });
  });
}

function telaDefinirSenha() {
  document.body.className = "pg-login";
  const convite = estado.precisaSenha === "invite";
  const provisoria = estado.precisaSenha === "provisoria";
  const nome = esc(estado.perfil.nome.split(" ")[0]);
  app.innerHTML = `
  <main class="login login-simples">
    <section class="login-form-wrap">
      <form class="login-form" id="fSenha" novalidate>
        <div class="login-marca">${logo()}<span>${esc(CONFIG.NOME_PORTAL)}</span></div>
        <h2>${convite || provisoria ? `Welcome, ${nome}` : "Create a new password"}</h2>
        <p class="muted">${provisoria ? "For security reasons, please replace your temporary password with a personal one before continuing."
          : convite ? "Set your password to access the portal." : "Choose a new password for your account."}</p>
        <label class="campo"><span>New password</span>
          <input type="password" name="s1" autocomplete="new-password" minlength="8" required></label>
        <label class="campo"><span>Confirm password</span>
          <input type="password" name="s2" autocomplete="new-password" minlength="8" required></label>
        <p class="dica">Minimum of 8 characters.</p>
        <p class="form-erro" aria-live="polite"></p>
        <button class="btn btn-primary btn-bloco" type="submit">Save password</button>
        ${provisoria ? `<button class="link" type="button" id="sairSenha">Sign out</button>` : ""}
      </form>
    </section>
  </main>`;
  const f = $("#fSenha");
  $("#sairSenha")?.addEventListener("click", async () => { await api.sair(); estado.perfil = null; estado.precisaSenha = null; location.hash = "#/"; rota(); });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const erro = $(".form-erro", f);
    erro.textContent = "";
    if (f.s1.value.length < 8) return (erro.textContent = "The password must be at least 8 characters long.");
    if (f.s1.value !== f.s2.value) return (erro.textContent = "The passwords do not match.");
    try {
      await api.definirSenha(f.s1.value);
      estado.precisaSenha = null;
      toast("Password set successfully.");
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
      <a href="#/" class="${ativo === "inicio" ? "on" : ""}">${icon("home")}<span>Home</span></a>
      ${estado.sistemas.map((d) => `<a href="#/d/${d.id}" class="${ativo === `d${d.id}` ? "on" : ""}">${icon("grid")}<span>${esc(d.titulo)}</span></a>`).join("")}
      <a href="#/avisos" class="${ativo === "avisos" ? "on" : ""}">${icon("megaphone")}<span>Announcements</span></a>
      ${p.is_admin ? `<a href="#/admin" class="${ativo === "admin" ? "on" : ""}">${icon("settings")}<span>Administration</span></a>` : ""}
    </nav>
    <div class="topo-user">
      <span class="avatar" title="${esc(p.email)}">${esc(iniciais(p.nome))}</span>
      <span class="topo-nome">${esc(p.nome.split(" ")[0] || p.email)}</span>
      <button class="btn-icon" id="sair" title="Sign out" aria-label="Sign out">${icon("logout")}</button>
    </div>
  </header>
  ${MODO_DEMO ? `<div class="faixa-demo">Demo mode — sample data stored in this browser only. <button class="link" id="resetDemo">Reset data</button></div>` : ""}
  ${banners.map((b) => `
    <div class="banner banner-${esc(b.nivel)}" data-banner="${b.id}">
      ${icon(NIVEL_ICON[b.nivel])}
      <div><strong>${esc(b.titulo)}</strong>${b.conteudo ? ` <span>${esc(b.conteudo)}</span>` : ""}
      ${b.link ? ` <a href="${esc(b.link)}" target="_blank" rel="noopener">Learn more</a>` : ""}</div>
      <button class="btn-icon" data-fecha-banner="${b.id}" aria-label="Dismiss announcement">${icon("x")}</button>
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

  const grupos = [...cats, { id: null, nome: "Other" }]
    .map((c) => ({ ...c, itens: visiveis.filter((d) => (d.categoria_id ?? null) === c.id) }))
    .filter((g) => g.itens.length);

  const atrasados = visiveis.filter((d) => !ehSistema(d) && statusAtualizacao(d).cls === "atrasado").length;

  await shell(`
    <section class="ola">
      <div>
        <h1>${saudacao()}, ${esc(p.nome.split(" ")[0])}</h1>
        <p class="muted">${visiveis.length} ${visiveis.length === 1 ? "report" : "reports"} available to you${atrasados ? ` · <span class="txt-alerta">${atrasados} overdue for refresh</span>` : ""}</p>
      </div>
      <label class="busca">${icon("search")}<input type="search" id="busca" placeholder="Search reports…" aria-label="Search reports"></label>
    </section>

    ${mural.length ? `
    <section class="secao">
      <div class="secao-h"><h2>${icon("megaphone")} Announcements</h2><a href="#/avisos" class="link">View all</a></div>
      <div class="mural">${mural.slice(0, 3).map(cardAviso).join("")}</div>
    </section>` : ""}

    ${grupos.length ? grupos.map((g) => `
      <section class="secao grupo" data-grupo>
        <div class="secao-h"><h2>${icon("folder")} ${esc(g.nome)}</h2><span class="muted">${g.itens.length}</span></div>
        <div class="grade">${g.itens.map(cardDashboard).join("")}</div>
      </section>`).join("") : `
      <div class="vazio">${icon("chart")}<h3>No reports available yet</h3>
        <p>${p.is_admin ? "Add the first report under Administration." : "Please ask the BI team to grant you access to the reports you need."}</p>
        ${p.is_admin ? `<a class="btn btn-primary" href="#/admin/dashboards">${icon("plus")} Add report</a>` : ""}
      </div>`}
    <div class="vazio oculto" id="semResultado">${icon("search")}<h3>No reports found</h3></div>
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
  const st = sistema ? { cls: "neutro", texto: "Integrated system" } : statusAtualizacao(d);
  return `
  <a class="card-dash ${d.ativo ? "" : "inativo"}" href="#/d/${d.id}" data-busca="${esc((d.titulo + " " + (d.descricao ?? "")).toLowerCase())}">
    <div class="card-dash-topo">
      <span class="card-ic">${icon(sistema ? "grid" : "chart")}</span>
      ${d.nota ? `<span class="tag tag-${esc(d.nota_tipo)}" title="${esc(d.nota)}">${icon(NIVEL_ICON[d.nota_tipo])}${d.nota_tipo === "info" ? "New" : "Attention"}</span>` : ""}
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
      ${a.link ? `<a class="link" href="${esc(a.link)}" target="_blank" rel="noopener">Learn more ${icon("external")}</a>` : ""}
    </div>
  </article>`;
}

async function telaAvisos() {
  const agora = new Date();
  const lista = (await api.avisos()).filter((a) => a.tipo === "mural" && a.ativo && new Date(a.inicio) <= agora && (!a.fim || new Date(a.fim) > agora));
  await shell(`
    <section class="ola"><div><h1>Announcements</h1><p class="muted">Communications from the BI team.</p></div></section>
    ${lista.length ? `<div class="mural mural-lista">${lista.map(cardAviso).join("")}</div>`
      : `<div class="vazio">${icon("megaphone")}<h3>No announcements at this time</h3></div>`}
  `, { ativo: "avisos" });
}

// =====================================================================
// VISUALIZADOR DO DASHBOARD
// =====================================================================
async function telaDashboard(id) {
  const d = await api.dashboard(id);
  if (!d) {
    return shell(`<div class="vazio">${icon("lock")}<h3>Report unavailable</h3>
      <p>You do not have access to this report, or it has been removed.</p><a class="btn" href="#/">Back to home</a></div>`);
  }
  const st = statusAtualizacao(d);
  const demo = d.link.startsWith("demo:");
  const sistema = ehSistema(d);
  await shell(`
    <div class="visor">
      <div class="visor-barra">
        <a class="btn-icon" href="#/" title="Back" aria-label="Back">${icon("back")}</a>
        <div class="visor-titulo">
          <h1>${esc(d.titulo)}</h1>
          ${sistema ? "" : `<div class="status status-${st.cls}">${icon("clock")}<span>${esc(st.texto)}</span>
            ${d.atualizado_em ? `<span class="muted">· ${esc(dataHoraBR(d.atualizado_em))} · ${esc(FREQ_LABEL[d.frequencia])}</span>` : ""}</div>`}
        </div>
        <div class="visor-acoes">
          <button class="btn btn-ghost" id="telaCheia">${icon("expand")}<span>Full screen</span></button>
          ${demo ? "" : `<a class="btn btn-ghost" href="${esc(d.link)}" target="_blank" rel="noopener">${icon("external")}<span>Open in new tab</span></a>`}
        </div>
      </div>
      ${d.nota ? `<div class="nota nota-${esc(d.nota_tipo)}">${icon(NIVEL_ICON[d.nota_tipo])}<span>${esc(d.nota)}</span></div>` : ""}
      <div class="visor-frame" id="frame">
        <iframe title="${esc(d.titulo)}" ${demo ? `srcdoc="${esc(demoRelatorio(d))}"` : `src="${esc(sistema ? semCache(d.link) : d.link)}"`}
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
  </style></head><body><header>${esc(d.titulo)} <small style="color:#8a93a3;font-weight:400">· demo report</small></header>
  <div class="g">${["Revenue", "Target", "Achieved", "Variance"].map((k, i) => `<div class="k"><span>${k}</span><b>${["R$ 4.8M", "R$ 5.1M", "94%", "+6.2%"][i]}</b></div>`).join("")}</div>
  <div class="c"><p>Monthly trend</p>${barras.map((b) => `<i style="height:${b}%"></i>`).join("")}</div>
  </body></html>`;
}

// =====================================================================
// ADMINISTRAÇÃO
// =====================================================================
const ABAS = [
  ["dashboards", "Reports", "chart"],
  ["categorias", "Categories", "folder"],
  ["usuarios", "Users", "users"],
  ["avisos", "Announcements", "megaphone"],
];

async function telaAdmin(aba) {
  const render = { dashboards: adminDashboards, categorias: adminCategorias, usuarios: adminUsuarios, avisos: adminAvisos }[aba];
  if (!render) { location.hash = "#/admin/dashboards"; return; }
  const corpo = await render();
  await shell(`
    <section class="ola"><div><h1>Administration</h1><p class="muted">Manage reports, user access and announcements.</p></div></section>
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
      <label class="busca">${icon("search")}<input type="search" id="filtro" placeholder="Filter reports…"></label>
      <button class="btn btn-primary" id="novo">${icon("plus")} New report</button>
    </div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Report</th><th>Category</th><th>Last refresh</th><th>Users</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${dashs.length ? dashs.map((d) => {
        const st = statusAtualizacao(d);
        return `<tr data-busca="${esc((d.titulo + " " + nomeCat(d.categoria_id)).toLowerCase())}">
          <td><strong>${esc(d.titulo)}</strong>${d.nota ? `<div class="sub tag-txt-${esc(d.nota_tipo)}">${icon(NIVEL_ICON[d.nota_tipo])}${esc(d.nota)}</div>` : ""}</td>
          <td>${esc(nomeCat(d.categoria_id))}</td>
          <td><span class="status status-${st.cls}">${icon("clock")}${esc(d.atualizado_em ? tempoRelativo(d.atualizado_em) : "—")}</span><div class="sub">${esc(FREQ_LABEL[d.frequencia])}</div></td>
          <td>${qtd(d.id)}</td>
          <td>${d.ativo ? `<span class="pill pill-ok">Active</span>` : `<span class="pill">Inactive</span>`}</td>
          <td class="acoes">
            <button class="btn-icon" data-atualizado="${d.id}" title="Mark as refreshed now" aria-label="Mark as refreshed now">${icon("refresh")}</button>
            <button class="btn-icon" data-editar="${d.id}" title="Edit" aria-label="Edit">${icon("edit")}</button>
            <button class="btn-icon perigo" data-excluir="${d.id}" title="Delete" aria-label="Delete">${icon("trash")}</button>
          </td></tr>`;
      }).join("") : `<tr><td colspan="6" class="vazio-td">No reports registered.</td></tr>`}
      </tbody></table></div>`,
    bind() {
      filtroTabela();
      $("#novo").addEventListener("click", () => formDashboard(null, cats));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => formDashboard(dashs.find((d) => d.id === Number(b.dataset.editar)), cats)));
      $$("[data-atualizado]").forEach((b) => b.addEventListener("click", async () => {
        try { await api.marcarAtualizado(Number(b.dataset.atualizado)); toast("Refresh recorded."); recarregar(); }
        catch (e) { toast(e.message, "erro"); }
      }));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const d = dashs.find((x) => x.id === Number(b.dataset.excluir));
        if (!(await confirmar("Delete report", `The report <strong>${esc(d.titulo)}</strong> and all access granted to it will be removed.`))) return;
        try { await api.excluirDashboard(d.id); toast("Report deleted."); recarregar(); } catch (e) { toast(e.message, "erro"); }
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
    titulo: novo ? "New report" : "Edit report",
    largura: "modal-lg",
    corpo: `
    <div class="form-grid">
      <label class="campo col-2"><span>Title *</span><input name="titulo" required maxlength="120" value="${esc(d.titulo)}"></label>
      <label class="campo"><span>Category</span><select name="categoria_id">
        <option value="">No category</option>
        ${cats.map((c) => `<option value="${c.id}" ${c.id === d.categoria_id ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}
      </select></label>
      <label class="campo"><span>Display order</span><input type="number" name="ordem" value="${esc(d.ordem)}"></label>
      <label class="campo col-2"><span>Power BI embed link *</span>
        <input type="url" name="link" required placeholder="https://app.powerbi.com/reportEmbed?reportId=…" value="${esc(d.link)}">
        <small class="dica">In Power BI: File › Embed report › Website or portal (or Publish to web).
          A link from ${esc(location.origin)} (e.g. the Daily Report) becomes an integrated system: it opens with the same sign-in and appears in the top menu.</small></label>
      <label class="campo col-2"><span>Description</span><textarea name="descricao" rows="2" maxlength="500">${esc(d.descricao ?? "")}</textarea></label>

      <fieldset class="col-2 grupo-campos"><legend>${icon("clock")} Refresh status</legend>
        <div class="form-grid">
          <label class="campo"><span>Expected frequency</span><select name="frequencia">
            ${Object.entries(FREQ_LABEL).map(([k, v]) => `<option value="${k}" ${k === d.frequencia ? "selected" : ""}>${v}</option>`).join("")}
          </select></label>
          <label class="campo"><span>Last data refresh</span>
            <div class="input-btn"><input type="datetime-local" name="atualizado_em" value="${toLocalInput(d.atualizado_em)}">
            <button type="button" class="btn btn-ghost" id="agora">Now</button></div></label>
        </div>
      </fieldset>

      <fieldset class="col-2 grupo-campos"><legend>${icon("info")} Report note</legend>
        <div class="form-grid">
          <label class="campo col-2"><span>Text shown on the report (optional)</span>
            <input name="nota" maxlength="200" placeholder="e.g. September figures under review" value="${esc(d.nota ?? "")}"></label>
          <label class="campo"><span>Type</span><select name="nota_tipo">
            <option value="info" ${d.nota_tipo === "info" ? "selected" : ""}>Information / new</option>
            <option value="alerta" ${d.nota_tipo === "alerta" ? "selected" : ""}>Warning</option>
            <option value="critico" ${d.nota_tipo === "critico" ? "selected" : ""}>Critical</option>
          </select></label>
          <label class="switch"><input type="checkbox" name="ativo" ${d.ativo ? "checked" : ""}><span></span>Report active</label>
        </div>
      </fieldset>

      <fieldset class="col-2 grupo-campos"><legend>${icon("users")} Who can view</legend>
        <p class="dica">Administrators automatically see all reports.</p>
        ${checklist("usuarios", comuns.map((u) => ({ v: u.id, t: u.nome || u.email, s: u.email, on: liberados.includes(u.id) })), "No standard users registered.")}
      </fieldset>
    </div>`,
    onOpen(f) {
      $("#agora", f).addEventListener("click", () => { f.atualizado_em.value = toLocalInput(new Date().toISOString()); });
      bindChecklist(f);
    },
    async onSubmit(f) {
      const titulo = f.titulo.value.trim();
      const link = f.link.value.trim();
      if (!titulo) throw new Error("Please enter a title.");
      if (!/^https:\/\//i.test(link) && !link.startsWith("demo:")) throw new Error("The link must start with https://");
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
      toast(novo ? "Report added." : "Report updated.");
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
    <div class="barra-acoes"><span></span><button class="btn btn-primary" id="novo">${icon("plus")} New category</button></div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Category</th><th>Order</th><th>Reports</th><th></th></tr></thead>
      <tbody>${cats.length ? cats.map((c) => `
        <tr><td><strong>${esc(c.nome)}</strong></td><td>${c.ordem}</td><td>${qtd(c.id)}</td>
        <td class="acoes">
          <button class="btn-icon" data-editar="${c.id}" aria-label="Edit">${icon("edit")}</button>
          <button class="btn-icon perigo" data-excluir="${c.id}" aria-label="Delete">${icon("trash")}</button>
        </td></tr>`).join("") : `<tr><td colspan="4" class="vazio-td">No categories.</td></tr>`}
      </tbody></table></div>`,
    bind() {
      const form = (c) => modal({
        titulo: c ? "Edit category" : "New category",
        corpo: `<div class="form-grid">
          <label class="campo col-2"><span>Name *</span><input name="nome" required maxlength="60" value="${esc(c?.nome ?? "")}"></label>
          <label class="campo"><span>Display order</span><input type="number" name="ordem" value="${c?.ordem ?? cats.length + 1}"></label></div>`,
        async onSubmit(f) {
          if (!f.nome.value.trim()) throw new Error("Please enter a name.");
          await api.salvarCategoria({ ...(c ? { id: c.id } : {}), nome: f.nome.value.trim(), ordem: Number(f.ordem.value) || 0 });
          toast("Category saved."); recarregar();
        },
      });
      $("#novo").addEventListener("click", () => form(null));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => form(cats.find((c) => c.id === Number(b.dataset.editar)))));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const c = cats.find((x) => x.id === Number(b.dataset.excluir));
        const n = qtd(c.id);
        if (!(await confirmar("Delete category", `Delete <strong>${esc(c.nome)}</strong>?${n ? ` Its ${n} report(s) will be moved to "Other".` : ""}`, "Delete"))) return;
        try { await api.excluirCategoria(c.id); toast("Category deleted."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

// ---------------------------------------------------------------- usuários
async function adminUsuarios() {
  const [usuarios, dashs, cats, acessos] = await Promise.all([api.usuarios(), api.dashboards(), api.categorias(), api.contagemAcessos()]);
  const qtd = (uid) => acessos.filter((a) => a.user_id === uid).length;
  const situacao = (u) => !u.ativo ? `<span class="pill">Inactive</span>`
    : u.trocar_senha ? `<span class="pill pill-alerta">Password change pending</span>`
    : u.confirmado === false ? `<span class="pill pill-alerta">Invitation pending</span>`
    : `<span class="pill pill-ok">Active</span>`;

  return {
    html: `
    <div class="barra-acoes">
      <label class="busca">${icon("search")}<input type="search" id="filtro" placeholder="Filter users…"></label>
      <button class="btn btn-primary" id="novo">${icon("plus")} New user</button>
    </div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>User</th><th>Role</th><th>Reports</th><th>Last access</th><th>Status</th><th></th></tr></thead>
      <tbody>${usuarios.map((u) => `
        <tr data-busca="${esc((u.nome + " " + u.email).toLowerCase())}">
          <td><div class="user-cel"><span class="avatar sm">${esc(iniciais(u.nome))}</span><div><strong>${esc(u.nome || "—")}</strong><div class="sub">${esc(u.email)}</div></div></div></td>
          <td>${u.is_admin ? `<span class="pill pill-adm">Administrator</span>` : "User"}</td>
          <td>${u.is_admin ? "All" : qtd(u.id)}</td>
          <td>${u.ultimo_acesso ? esc(tempoRelativo(u.ultimo_acesso)) : `<span class="muted">Never</span>`}</td>
          <td>${situacao(u)}</td>
          <td class="acoes">
            <button class="btn-icon" data-senha="${u.id}" title="Set temporary password" aria-label="Set temporary password">${icon("key")}</button>
            <button class="btn-icon" data-editar="${u.id}" title="Edit" aria-label="Edit">${icon("edit")}</button>
            ${u.id !== estado.perfil.id ? `<button class="btn-icon perigo" data-excluir="${u.id}" title="Delete" aria-label="Delete">${icon("trash")}</button>` : `<span class="btn-icon-vazio"></span>`}
          </td></tr>`).join("")}
      </tbody></table></div>`,
    bind() {
      filtroTabela();
      $("#novo").addEventListener("click", () => formUsuario(null, dashs, cats));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => formUsuario(usuarios.find((u) => u.id === b.dataset.editar), dashs, cats)));
      $$("[data-senha]").forEach((b) => b.addEventListener("click", () => {
        const u = usuarios.find((x) => x.id === b.dataset.senha);
        modal({
          titulo: "Set temporary password",
          botao: "Save password",
          corpo: `<p class="muted">Define a temporary password for <strong>${esc(u.nome || u.email)}</strong>.
            They will be required to change it at their next sign-in.</p>
            ${campoSenhaProvisoria()}
            <p class="dica">${icon("alert")} If this user also signs in to other systems with the same account (e.g. the Daily Report), the new password applies there too.</p>`,
          onOpen: bindSenhaProvisoria,
          async onSubmit(f) {
            const senha = f.senha.value;
            if (senha.length < 8) throw new Error("The temporary password must be at least 8 characters long.");
            await api.redefinirSenha(u.id, senha);
            toast(`Temporary password set for ${u.email}. Share it with the user.`);
            recarregar();
          },
        });
      }));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const u = usuarios.find((x) => x.id === b.dataset.excluir);
        if (!(await confirmar("Delete user", `<strong>${esc(u.nome)}</strong> will lose access to the portal (their sign-in to other systems is not affected). To block access temporarily, deactivate the user instead.`, "Delete"))) return;
        try { await api.excluirUsuario(u.id); toast("User deleted."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

async function formUsuario(u, dashs, cats) {
  const novo = !u;
  const liberados = novo ? [] : await api.acessosDoUsuario(u.id);
  const eu = u?.id === estado.perfil.id;
  const opcoes = [...cats, { id: null, nome: "Other" }].flatMap((c) =>
    dashs.filter((d) => (d.categoria_id ?? null) === c.id).map((d) => ({ v: d.id, t: d.titulo, s: c.nome, on: liberados.includes(d.id) })));

  modal({
    titulo: novo ? "New user" : "Edit user",
    botao: novo ? "Create user" : "Save",
    largura: "modal-lg",
    corpo: `
    <div class="form-grid">
      <label class="campo"><span>Name *</span><input name="nome" required maxlength="120" value="${esc(u?.nome ?? "")}"></label>
      <label class="campo"><span>E-mail *</span><input type="email" name="email" required value="${esc(u?.email ?? "")}" ${novo ? "" : "disabled"}></label>
      <label class="switch"><input type="checkbox" name="is_admin" ${u?.is_admin ? "checked" : ""} ${eu ? "disabled" : ""}><span></span>Administrator</label>
      ${novo ? "" : `<label class="switch"><input type="checkbox" name="ativo" ${u.ativo ? "checked" : ""} ${eu ? "disabled" : ""}><span></span>Access active</label>`}
      ${novo ? `<div class="col-2">${campoSenhaProvisoria()}
        <p class="dica">${icon("key")} No e-mail is sent: share this password with the user. They will be required to change it at first sign-in.
          If the e-mail already has an account (e.g. the Daily Report), access is granted and they keep their current password.</p></div>` : ""}
      <fieldset class="col-2 grupo-campos" id="gDash"><legend>${icon("chart")} Report access</legend>
        <p class="dica adm-dica">Administrators see all reports.</p>
        ${checklist("dashs", opcoes, "No reports registered.")}
      </fieldset>
    </div>`,
    onOpen(f) {
      bindChecklist(f);
      if (novo) bindSenhaProvisoria(f);
      const sync = () => $("#gDash", f).classList.toggle("desabilitado", f.is_admin.checked);
      f.is_admin.addEventListener("change", sync); sync();
    },
    async onSubmit(f) {
      const nome = f.nome.value.trim();
      if (!nome) throw new Error("Please enter a name.");
      const dashboards = $$('input[name="dashs"]:checked', f).map((c) => Number(c.value));
      if (novo) {
        const email = f.email.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Invalid e-mail address.");
        const senha = f.senha.value;
        if (senha.length < 8) throw new Error("The temporary password must be at least 8 characters long.");
        const r = await api.criarUsuario({ nome, email, senha, is_admin: f.is_admin.checked, dashboards });
        toast(r?.ja_tinha_login
          ? `${email} already had an account: access granted with their existing password.`
          : `User created. Share the temporary password with ${email}.`);
      } else {
        await api.salvarUsuario({ id: u.id, nome, is_admin: eu ? u.is_admin : f.is_admin.checked, ativo: eu ? true : f.ativo.checked }, dashboards);
        toast("User updated.");
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
  const situacao = (a) => !a.ativo ? ["Inactive", ""]
    : new Date(a.inicio) > agora ? ["Scheduled", "pill-alerta"]
    : a.fim && new Date(a.fim) <= agora ? ["Expired", ""]
    : ["Live", "pill-ok"];
  return {
    html: `
    <div class="barra-acoes"><span class="muted">Banners appear at the top of every page; board announcements appear on the home page.</span>
      <button class="btn btn-primary" id="novo">${icon("plus")} New announcement</button></div>
    <div class="tabela-wrap"><table class="tabela">
      <thead><tr><th>Announcement</th><th>Type</th><th>Period</th><th>Status</th><th></th></tr></thead>
      <tbody>${avisos.length ? avisos.map((a) => {
        const [s, c] = situacao(a);
        return `<tr>
          <td><div class="aviso-cel tag-txt-${esc(a.nivel)}">${icon(NIVEL_ICON[a.nivel])}<div><strong>${esc(a.titulo)}</strong><div class="sub">${esc((a.conteudo ?? "").slice(0, 90))}</div></div></div></td>
          <td>${a.tipo === "banner" ? "Banner" : "Board"}</td>
          <td class="nowrap">${esc(dataBR(a.inicio))} → ${a.fim ? esc(dataBR(a.fim)) : "no end date"}</td>
          <td><span class="pill ${c}">${s}</span></td>
          <td class="acoes">
            <button class="btn-icon" data-editar="${a.id}" aria-label="Edit">${icon("edit")}</button>
            <button class="btn-icon perigo" data-excluir="${a.id}" aria-label="Delete">${icon("trash")}</button>
          </td></tr>`;
      }).join("") : `<tr><td colspan="5" class="vazio-td">No announcements registered.</td></tr>`}
      </tbody></table></div>`,
    bind() {
      $("#novo").addEventListener("click", () => formAviso(null));
      $$("[data-editar]").forEach((b) => b.addEventListener("click", () => formAviso(avisos.find((a) => a.id === Number(b.dataset.editar)))));
      $$("[data-excluir]").forEach((b) => b.addEventListener("click", async () => {
        const a = avisos.find((x) => x.id === Number(b.dataset.excluir));
        if (!(await confirmar("Delete announcement", `Delete <strong>${esc(a.titulo)}</strong>?`, "Delete"))) return;
        try { await api.excluirAviso(a.id); toast("Announcement deleted."); recarregar(); } catch (e) { toast(e.message, "erro"); }
      }));
    },
  };
}

function formAviso(a) {
  const novo = !a;
  a = a ?? { tipo: "mural", nivel: "info", titulo: "", conteudo: "", imagem_url: null, link: "", inicio: new Date().toISOString(), fim: null, ativo: true };
  let imagem = a.imagem_url;
  modal({
    titulo: novo ? "New announcement" : "Edit announcement",
    largura: "modal-lg",
    corpo: `
    <div class="form-grid">
      <label class="campo"><span>Display location</span><select name="tipo">
        <option value="mural" ${a.tipo === "mural" ? "selected" : ""}>Announcement board (home page)</option>
        <option value="banner" ${a.tipo === "banner" ? "selected" : ""}>Highlight banner (top of page)</option></select></label>
      <label class="campo"><span>Level</span><select name="nivel">
        <option value="info" ${a.nivel === "info" ? "selected" : ""}>Information</option>
        <option value="alerta" ${a.nivel === "alerta" ? "selected" : ""}>Warning</option>
        <option value="critico" ${a.nivel === "critico" ? "selected" : ""}>Critical</option></select></label>
      <label class="campo col-2"><span>Title *</span><input name="titulo" required maxlength="120" value="${esc(a.titulo)}"></label>
      <label class="campo col-2"><span>Text</span><textarea name="conteudo" rows="4" maxlength="1000">${esc(a.conteudo ?? "")}</textarea></label>
      <label class="campo col-2"><span>"Learn more" link (optional)</span><input type="url" name="link" placeholder="https://…" value="${esc(a.link ?? "")}"></label>
      <div class="campo col-2" id="campoImg"><span>Image (board only)</span>
        <div class="img-up">
          <div class="img-prev" id="prev">${imagem ? `<img src="${esc(imagem)}" alt="">` : icon("image")}</div>
          <div><input type="file" accept="image/png,image/jpeg,image/webp" id="arq">
          <button type="button" class="link ${imagem ? "" : "oculto"}" id="remImg">Remove image</button>
          <p class="dica">PNG, JPG or WEBP up to 2 MB.</p></div>
        </div></div>
      <label class="campo"><span>Start</span><input type="datetime-local" name="inicio" value="${toLocalInput(a.inicio)}"></label>
      <label class="campo"><span>End (optional)</span><input type="datetime-local" name="fim" value="${toLocalInput(a.fim)}"></label>
      <label class="switch"><input type="checkbox" name="ativo" ${a.ativo ? "checked" : ""}><span></span>Active</label>
    </div>`,
    onOpen(f) {
      const sync = () => $("#campoImg", f).classList.toggle("oculto", f.tipo.value !== "mural");
      f.tipo.addEventListener("change", sync); sync();
      $("#arq", f).addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { toast("Image is larger than 2 MB.", "erro"); e.target.value = ""; return; }
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
      if (!f.titulo.value.trim()) throw new Error("Please enter a title.");
      const inicio = fromLocalInput(f.inicio.value) ?? new Date().toISOString();
      const fim = fromLocalInput(f.fim.value);
      if (fim && fim <= inicio) throw new Error("The end date must be after the start date.");
      const link = f.link.value.trim();
      if (link && !/^https?:\/\//i.test(link)) throw new Error("The link must start with http:// or https://");
      await api.salvarAviso({
        ...(novo ? {} : { id: a.id }),
        tipo: f.tipo.value, nivel: f.nivel.value, titulo: f.titulo.value.trim(),
        conteudo: f.conteudo.value.trim() || null, link: link || null,
        imagem_url: f.tipo.value === "mural" ? imagem : null,
        inicio, fim, ativo: f.ativo.checked,
      });
      toast("Announcement saved."); recarregar();
    },
  });
}

// ---------------------------------------------------------------- helpers admin
// Campo de senha provisória (visível, para o admin copiar e repassar)
function campoSenhaProvisoria() {
  return `<label class="campo"><span>Temporary password *</span>
    <div class="input-btn"><input type="text" name="senha" minlength="8" required autocomplete="off" spellcheck="false">
    <button type="button" class="btn btn-ghost" data-gerar>Generate</button>
    <button type="button" class="btn btn-ghost" data-copiar>Copy</button></div></label>`;
}

function bindSenhaProvisoria(root) {
  const campo = $('input[name="senha"]', root);
  // sem caracteres ambíguos (0/O, 1/l/I) para facilitar o repasse
  const gerar = () => {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const n = crypto.getRandomValues(new Uint32Array(10));
    campo.value = Array.from(n, (x) => abc[x % abc.length]).join("");
  };
  gerar();
  $("[data-gerar]", root).addEventListener("click", gerar);
  $("[data-copiar]", root).addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(campo.value); toast("Password copied."); }
    catch { campo.select(); }
  });
}

function checklist(nome, itens, vazio) {
  if (!itens.length) return `<p class="muted">${vazio}</p>`;
  return `
  <div class="check-ferr">
    <label class="busca sm">${icon("search")}<input type="search" data-check-busca placeholder="Filter…"></label>
    <span class="muted" data-check-cont></span>
    <button type="button" class="link" data-check-todos>Select all</button>
    <button type="button" class="link" data-check-nenhum>Clear</button>
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
  const conta = () => { cont.textContent = `${caixas().filter((c) => c.checked).length} of ${caixas().length} selected`; };
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
