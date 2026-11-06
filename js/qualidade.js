// Qualidade: painéis nativos do portal no lugar do Qualidade.pbix (Power BI), lidos ao
// vivo do Digisul pelo brascof-api (/api/qualidade). Pensados para o time de qualidade:
// as mesmas informações do .pbix, em gráficos escolhidos para cada pergunta, mais
// algumas visões novas (conformidade na chegada, idade do estoque, amostras).
//
// Painéis (link cadastrado em bi_dashboards):
//   portal:qualidade-daily      Daily Summary — próximos 15 dias e estoque
//   portal:qualidade-purchases  Purchases — compras a receber, atrasos, qualidade
//   portal:qualidade-domestic   Internal Market — vendas no mercado interno
//   portal:qualidade-exports    Export Shipments — embarques, amostras, booking
//   portal:qualidade-inventory  Inventory — estoque por qualidade, idade, armazém
//   portal:qualidade-services   Service Orders — guias de serviço e despejo x resultado
//   portal:qualidade-arrivals   Purchase x Arrival — classificação do lote x contrato
import { esc, $, $$, icon } from "./ui.js";
import { fmtN, fmtMes, fmtData, vigiarNegativos } from "./position.js";
import { LOCALE } from "./i18n.js";

const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm";
export const ehPainelQualidade = (link) => /^portal:qualidade-/.test(link ?? "");

// =====================================================================
// UTILITÁRIOS
// =====================================================================
const soma = (rows, f) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
const somarDias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const entre = (d, de, ate) => !!d && d >= de && d <= ate;
const mesDe = (d) => (d ? d.slice(0, 7) : null);
const pct = (v, dec = 0) => (v == null || !Number.isFinite(v) ? "—" : `${fmtN(v * 100, dec)}%`);
const fmtK = (v) => (Math.abs(v) >= 1000 ? fmtN(v / 1000, Math.abs(v) >= 10000 ? 0 : 1, "k") : fmtN(v));
const moeda = (v, sim) => (v == null ? "—" : `${sim} ${fmtN(v, 0)}`);
const diaCurto = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// lista de meses 'YYYY-MM' de `de` até `ate`
function meses(de, ate) {
  const out = [];
  let [a, m] = de.split("-").map(Number);
  const [a2, m2] = ate.split("-").map(Number);
  while (a < a2 || (a === a2 && m <= m2)) { out.push(`${a}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; a++; } }
  return out;
}
const somarMeses = (ym, n) => { const [a, m] = ym.split("-").map(Number); const t = a * 12 + m - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
// agrupa e soma: [[chave, valor]] do maior para o menor
function ranking(rows, chave, valor, { top = 12, outros = "Other" } = {}) {
  const m = new Map();
  for (const r of rows) { const k = chave(r) || "(blank)"; m.set(k, (m.get(k) ?? 0) + (Number(valor(r)) || 0)); }
  const ord = [...m].filter(([, v]) => Math.abs(v) >= 0.5).sort((a, b) => b[1] - a[1]);
  if (ord.length <= top) return ord;
  const resto = ord.slice(top - 1).reduce((s, [, v]) => s + v, 0);
  return [...ord.slice(0, top - 1), [outros, resto]];
}
const qtd = (n, um, varios) => `${fmtN(n)} ${n === 1 ? um : varios}`;

// =====================================================================
// GRÁFICOS (Chart.js, cores do tema: séries validadas para daltonismo)
// =====================================================================
let chartPromise;
const carregarChart = () => (chartPromise ??= import(CHART_URL).then((m) => { m.Chart.register(...m.registerables); return m.Chart; }));
let graficos = [];
const limparGraficos = () => { graficos.forEach((c) => c.destroy()); graficos = []; };
function tema() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return { s1: v("--serie-1"), s2: v("--serie-2"), s3: v("--serie-3"), pos: v("--div-pos"), neg: v("--div-neg"),
    tinta: v("--texto"), tinta2: v("--texto-2"), muda: v("--texto-3"), grade: v("--borda"), sup: v("--sup") };
}
// tom de uma cor (rampa sequencial de um matiz só): mistura com a superfície
const tom = (cor, sup, f) => `color-mix(in srgb, ${cor} ${Math.round(f * 100)}%, ${sup})`;
const cortar = (s, n = 26) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

// spec: { rotulos, series:[{rotulo, dados, cor?, cores?}], horizontal, empilhado, linha, unidade, fmt }
async function desenhar(canvas, spec) {
  const Chart = await carregarChart();
  const t = tema();
  const fmt = spec.fmt ?? fmtN;
  const corPadrao = [t.s1, t.s2, t.s3];
  const varias = spec.series.length > 1;
  const datasets = spec.series.map((s, i) => {
    const cor = s.cor ?? corPadrao[i];
    return spec.linha
      ? { label: s.rotulo, data: s.dados, borderColor: cor, backgroundColor: cor, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
          pointBorderColor: t.sup, pointBorderWidth: 2, tension: 0, spanGaps: true }
      : { label: s.rotulo, data: s.dados, backgroundColor: s.cores ?? (!varias && spec.rotulos.includes("Other") ? spec.rotulos.map((r) => (r === "Other" ? t.muda : cor)) : cor), borderColor: t.sup, borderWidth: { top: 0, bottom: 0, left: 0, right: 0 },
          borderRadius: 4, borderSkipped: "start", maxBarThickness: spec.horizontal ? 22 : 34, categoryPercentage: 0.8, barPercentage: varias ? 0.92 : 0.8 };
  });
  const eixoValor = { grid: { color: t.grade }, border: { display: false }, stacked: !!spec.empilhado, beginAtZero: true,
    ticks: { color: t.muda, font: { size: 11 }, callback: (v) => (spec.fmtEixo ?? fmtK)(v) } };
  if (spec.min != null) eixoValor.min = spec.min;
  if (spec.max != null) eixoValor.max = spec.max;
  const eixoCat = { grid: { display: false }, border: { color: t.grade }, stacked: !!spec.empilhado,
    ticks: { color: spec.horizontal ? t.tinta2 : t.muda, font: { size: 11 }, autoSkip: !spec.horizontal, maxRotation: 0,
      callback(v) { return cortar(this.getLabelForValue(v), spec.horizontal ? 38 : 12); } } };
  const c = new Chart(canvas, {
    type: spec.linha ? "line" : "bar",
    data: { labels: spec.rotulos, datasets },
    options: {
      indexAxis: spec.horizontal ? "y" : "x", responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false, axis: spec.horizontal ? "y" : "x" },
      scales: spec.horizontal ? { x: eixoValor, y: eixoCat } : { x: eixoCat, y: eixoValor },
      plugins: {
        legend: { display: varias, position: "top", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: {
          title: (it) => it[0]?.label ?? "",
          label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw == null ? "—" : fmt(ctx.raw)}${spec.unidade ? " " + spec.unidade : ""}` } },
      },
    },
  });
  graficos.push(c);
}

// tabela que acompanha cada gráfico (o mesmo dado, legível sem cor)
function tabelaDoGrafico(spec) {
  const fmt = spec.fmt ?? fmtN;
  return `<div class="pos-tabela qa-tab-graf"><table class="tabela tabela-num"><thead><tr><th></th>${spec.series.map((s) => `<th>${esc(s.rotulo)}</th>`).join("")}</tr></thead>
    <tbody>${spec.rotulos.map((r, i) => `<tr><td>${esc(r)}</td>${spec.series.map((s) => `<td class="num">${s.dados[i] == null ? "—" : esc(fmt(s.dados[i]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// cartão com gráfico (e botão para ver a tabela)
let specs = new Map();
function cartao(id, titulo, sub, spec, { alto, classe = "qa-s6" } = {}) {
  const vazio = !spec.rotulos.length || spec.series.every((s) => s.dados.every((v) => !v));
  const h = alto ?? (spec.horizontal ? Math.max(150, spec.rotulos.length * 30 + (spec.series.length > 1 ? 70 : 40)) : 260);
  if (!vazio) specs.set(id, spec);
  return `<section class="pos-card ${classe}">
    <div class="pos-card-h pos-card-h-linha"><div><h2>${esc(titulo)}</h2>${sub ? `<p class="muted">${sub}</p>` : ""}</div>
      ${vazio ? "" : `<button type="button" class="link qa-vt" data-vt="${id}" aria-pressed="false">Table</button>`}</div>
    ${vazio ? `<p class="muted qa-vazio">Nothing for this selection.</p>`
      : `<div class="pos-grafico" style="height:${h}px" id="qg-${id}"><canvas aria-label="${esc(titulo)}" role="img"></canvas></div><div class="oculto" id="qt-${id}"></div>`}
  </section>`;
}
async function ligarCartoes(raiz) {
  for (const [id, spec] of specs) {
    const caixa = $(`#qg-${id}`, raiz);
    if (!caixa) continue;
    await desenhar($("canvas", caixa), spec);
    $(`#qt-${id}`, raiz).innerHTML = tabelaDoGrafico(spec);
  }
  $$(".qa-vt", raiz).forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.vt, tab = b.getAttribute("aria-pressed") !== "true";
    $(`#qg-${id}`, raiz).classList.toggle("oculto", tab);
    $(`#qt-${id}`, raiz).classList.toggle("oculto", !tab);
    b.setAttribute("aria-pressed", String(tab));
    b.textContent = tab ? "Chart" : "Table";
  }));
}

// indicadores
const kpi = (t, v, s = "", tomK = "") =>
  `<div class="pos-kpi pos-kpi-est ${tomK ? `pos-kpi-${tomK}` : ""}"><div class="pos-kpi-t">${tomK ? icon("alert") : ""}${esc(t)}</div><div class="pos-kpi-v">${v}</div>${s ? `<div class="pos-kpi-s">${s}</div>` : ""}</div>`;

// barra segmentada (parte do todo, até 4 partes): nomes na legenda, valor no bloco quando cabe
function barraSegmentos(partes, unidade = "bags") {
  const t = tema(), cores = [t.s1, t.s2, t.s3, t.muda];
  const tot = partes.reduce((s, p) => s + p[1], 0);
  if (!tot) return `<p class="muted qa-vazio">Nothing for this selection.</p>`;
  return `<div class="qa-seg" role="img" aria-label="${esc(partes.map(([n, v]) => `${n}: ${fmtN(v)} ${unidade}`).join("; "))}">
    ${partes.filter((p) => p[1] > 0).map(([n, v], i) => `<span style="flex:${v};background:${cores[i]}" title="${esc(n)}: ${fmtN(v)} ${unidade} (${pct(v / tot)})">${v / tot >= 0.12 ? `${pct(v / tot)}` : ""}</span>`).join("")}
  </div>
  <div class="qa-leg">${partes.map(([n, v], i) => `<span><i style="background:${cores[i]}"></i>${esc(n)} <b>${fmtN(v)}</b> <em>${pct(v / tot)}</em></span>`).join("")}</div>`;
}

// =====================================================================
// TABELAS DE DADOS (ordenáveis, com total)
// =====================================================================
// cols: [chave, rótulo, tipo] — tipo: t (texto), n (inteiro), n2, p (percentual 0–100), d (data), brl, usd
const fmtCel = (v, tipo) => {
  if (v == null || v === "") return "—";
  switch (tipo) {
    case "n": return fmtN(v);
    case "n2": return fmtN(v, 2);
    case "p": return `${fmtN(v, v % 1 ? 1 : 0)}%`;
    case "d": return fmtData(v);
    case "brl": return fmtN(v, 2);
    case "usd": return fmtN(v, 2);
    default: return v;
  }
};
const NUMERICOS = new Set(["n", "n2", "p", "brl", "usd"]);
let tabelas = new Map();
function tabela(id, titulo, sub, cols, rows, { ordem, desc = false, totais = [], marcar, classe = "qa-s12", limite = 400 } = {}) {
  tabelas.set(id, { cols, rows, ordem: ordem ?? cols[0][0], desc, totais, marcar, limite });
  return `<section class="pos-card ${classe}">
    <div class="pos-card-h pos-card-h-linha"><div><h2>${esc(titulo)}</h2>${sub ? `<p class="muted">${sub}</p>` : ""}</div>
      <span class="muted qa-conta">${qtd(rows.length, "row", "rows")}</span></div>
    <div class="pos-tabela" id="qd-${id}"></div></section>`;
}
function desenharTabela(raiz, id) {
  const tb = tabelas.get(id), alvo = $(`#qd-${id}`, raiz);
  if (!alvo) return;
  if (!tb.rows.length) { alvo.innerHTML = `<p class="muted qa-vazio">Nothing for this selection.</p>`; return; }
  const tipo = tb.cols.find((c) => c[0] === tb.ordem)?.[2];
  const val = (r) => r[tb.ordem];
  const ord = [...tb.rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = NUMERICOS.has(tipo) ? x - y : String(x).localeCompare(String(y), LOCALE, { numeric: true });
    return tb.desc ? -c : c;
  });
  const vis = ord.slice(0, tb.limite);
  alvo.innerHTML = `<table class="tabela tabela-num qa-dados"><thead><tr>${tb.cols.map(([k, r, ti]) =>
    `<th class="${NUMERICOS.has(ti) ? "num" : ""}" data-ord="${k}" aria-sort="${k === tb.ordem ? (tb.desc ? "descending" : "ascending") : "none"}">${esc(r)}${k === tb.ordem ? (tb.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
    <tbody>${vis.map((r) => `<tr${tb.marcar?.(r) ? ` class="qa-marca"` : ""}>${tb.cols.map(([k, , ti]) => `<td class="${NUMERICOS.has(ti) ? "num" : ""}">${esc(fmtCel(r[k], ti))}</td>`).join("")}</tr>`).join("")}</tbody>
    ${tb.totais.length ? `<tfoot><tr>${tb.cols.map(([k, , ti], i) => `<td class="${NUMERICOS.has(ti) ? "num" : ""}">${i === 0 ? "Total" : tb.totais.includes(k) ? esc(fmtCel(soma(tb.rows, (r) => r[k]), ti)) : ""}</td>`).join("")}</tr></tfoot>` : ""}
  </table>${ord.length > tb.limite ? `<p class="muted qa-mais">Showing the first ${fmtN(tb.limite)} of ${fmtN(ord.length)} rows — use the filters to narrow down.</p>` : ""}`;
  $$("th[data-ord]", alvo).forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.ord;
    if (tb.ordem === k) tb.desc = !tb.desc; else { tb.ordem = k; tb.desc = NUMERICOS.has(tb.cols.find((c) => c[0] === k)[2]); }
    desenharTabela(raiz, id);
  }));
}

// =====================================================================
// FILTROS (uma linha acima de tudo; cada lista mostra o que existe com os outros filtros)
// =====================================================================
// defs: [{ k, rot, val: (r) => valor, rotulo?: (v) => texto, ordem?: 'desc' }]
function filtrar(rows, defs, estado, exceto) {
  const q = (estado.busca ?? "").trim().toLowerCase();
  return rows.filter((r) => defs.every((d) => d.k === exceto || !estado[d.k] || String(d.val(r) ?? "") === estado[d.k])
    && (!q || !estado._buscaEm || estado._buscaEm(r).some((x) => String(x ?? "").toLowerCase().includes(q))));
}
function barraFiltros(rows, defs, estado, { busca } = {}) {
  const opcoes = (d) => {
    const vs = [...new Set(filtrar(rows, defs, estado, d.k).map((r) => d.val(r)).filter((v) => v != null && v !== ""))]
      .map(String).sort((a, b) => a.localeCompare(b, LOCALE, { numeric: true }));
    if (d.ordem === "desc") vs.reverse();
    if (estado[d.k] && !vs.includes(estado[d.k])) vs.unshift(estado[d.k]);
    return vs;
  };
  const algum = defs.some((d) => estado[d.k]) || estado.busca;
  return `<div class="pos-filtros qa-filtros">
    ${busca ? `<label class="busca sm">${icon("search")}<input type="search" id="qaBusca" placeholder="${esc(busca)}" value="${esc(estado.busca ?? "")}" aria-label="${esc(busca)}"></label>` : ""}
    ${defs.map((d) => `<label class="qa-fil"><span>${esc(d.rot)}</span><select data-fil="${d.k}"><option value="">All</option>
      ${opcoes(d).map((v) => `<option value="${esc(v)}" ${estado[d.k] === v ? "selected" : ""}>${esc(d.rotulo ? d.rotulo(v) : v)}</option>`).join("")}</select></label>`).join("")}
    ${algum ? `<button type="button" class="link" id="qaLimpar">${icon("x")}Clear filters</button>` : ""}
  </div>`;
}
function ligarFiltros(raiz, defs, estado, redesenhar) {
  $$("select[data-fil]", raiz).forEach((s) => s.addEventListener("change", () => { estado[s.dataset.fil] = s.value; redesenhar(); }));
  $("#qaLimpar", raiz)?.addEventListener("click", () => { defs.forEach((d) => (estado[d.k] = "")); estado.busca = ""; redesenhar(); });
  const b = $("#qaBusca", raiz);
  if (b) {
    let t;
    b.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { estado.busca = b.value; redesenhar(true); }, 250); });
  }
}

// =====================================================================
// ENTRADA
// =====================================================================
const NOMES = {
  daily: "Daily Summary", purchases: "Purchases", domestic: "Internal Market", exports: "Export Shipments",
  inventory: "Inventory", services: "Service Orders", arrivals: "Purchase x Arrival",
};
const PAINEIS = {};

export async function renderQualidade(link, alvo, ctx) {
  const view = link.replace(/^portal:qualidade-/, "");
  const painel = PAINEIS[view];
  vigiarNegativos(alvo);
  if (!painel) { alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Unknown quality view</h3></div>`; return; }
  const carregar = async (fresco = false) => {
    limparGraficos();
    alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading ${esc(NOMES[view])} from Digisul…</div>`;
    let dados;
    try { dados = await ctx.api.qualidade(view, fresco); }
    catch (e) {
      alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Digisul data is not available</h3><p>${esc(e.message)}</p>
        <button class="btn" id="qaTentar">${icon("refresh")}<span>Try again</span></button></div>`;
      $("#qaTentar", alvo)?.addEventListener("click", () => carregar(true));
      return;
    }
    alvo.innerHTML = `<div class="pos qa">
      <div class="pos-topo">
        <div class="pos-data">${icon("clock")}<span>Live from Digisul · data as of <strong>${esc(new Date(dados.consultado_em ?? dados.gerado_em).toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</strong></span><span class="muted">· all volumes in 60 kg bags</span></div>
        <div class="pos-acoes"><button class="btn" id="qaAtualizar" title="Fetch Digisul again">${icon("refresh")}<span>Refresh</span></button></div>
      </div>
      <div id="qaCorpo"></div></div>`;
    $("#qaAtualizar", alvo).addEventListener("click", () => carregar(true));
    await painel($("#qaCorpo", alvo), dados);
  };
  await carregar();
}

// Monta um painel com filtros: `corpo(rows filtradas)` devolve o HTML das seções
function montar(alvo, { rows, defs, estado, busca, corpo }) {
  const desenharTudo = async (soCorpo = false) => {
    limparGraficos(); specs = new Map(); tabelas = new Map();
    const html = corpo(filtrar(rows, defs, estado));
    if (soCorpo && $("#qaSecoes", alvo)) $("#qaSecoes", alvo).innerHTML = html;
    else {
      alvo.innerHTML = `${defs.length || busca ? barraFiltros(rows, defs, estado, { busca }) : ""}<div class="qa-grade" id="qaSecoes">${html}</div>`;
      ligarFiltros(alvo, defs, estado, desenharTudo);
    }
    for (const id of tabelas.keys()) desenharTabela(alvo, id);
    await ligarCartoes(alvo);
  };
  return desenharTudo();
}

// =====================================================================
// DAILY SUMMARY — o que entra e sai nos próximos 15 dias + estoque
// =====================================================================
PAINEIS.daily = async (alvo, d) => {
  const hoje = d.hoje, ate = somarDias(hoje, 14);
  const dias = Array.from({ length: 15 }, (_, i) => somarDias(hoje, i));
  const comprasJan = d.compras.filter((r) => entre(r.prev_entrega, hoje, ate) && r.status === "A Receber");
  const vendasJan = d.vendas.filter((r) => entre(r.prev_embarque, hoje, ate) && r.status === "A Entregar");
  const expJan = d.exportacao.filter((r) => entre(r.prev_carga, hoje, ate) && r.status_embarque === "To be Shipped");
  const pagar = d.compras.filter((r) => entre(r.vencimento, hoje, ate));
  const porLote = new Map(d.estoque.map((r) => [r.lote, r]));
  const disp = d.lotes.map((l) => ({ ...l, _e: porLote.get(l.lote) }));
  const estoqueTot = soma(d.estoque, (r) => r.sacas), dispTot = soma(disp, (r) => r.sacas);
  const idade = d.estoque.length ? soma(d.estoque, (r) => r.dias) / d.estoque.length : null;

  specs = new Map(); tabelas = new Map(); limparGraficos();
  const porDia = (rows, campo, val) => dias.map((x) => soma(rows.filter((r) => r[campo] === x), val));
  const t = tema();
  const classes = ["PRONTO", "BICA CORRIDA", "CONSUMO"];
  const rotClasse = { PRONTO: "Ready (screened)", "BICA CORRIDA": "Unscreened (bica corrida)", CONSUMO: "Consumption grade" };
  const rkQual = ranking(expJan, (r) => r.padrao, (r) => r.sacas);
  const rkArm = ranking(d.estoque, (r) => r.armazem, (r) => r.sacas, { top: 8 });
  const rkCli = ranking(vendasJan, (r) => r.cliente, (r) => r.a_entregar, { top: 8 });

  alvo.innerHTML = `<div class="qa-grade">
    <div class="pos-kpis qa-s12">
      ${kpi("Purchases to receive · 15 days", fmtN(soma(comprasJan, (r) => r.a_entregar)), `${qtd(comprasJan.length, "contract", "contracts")} still to deliver`)}
      ${kpi("Domestic sales to deliver · 15 days", fmtN(soma(vendasJan, (r) => r.a_entregar)), `${qtd(vendasJan.length, "contract", "contracts")} · R$ ${fmtN(soma(vendasJan, (r) => r.saldo_reais))} balance`)}
      ${kpi("Exports to load · 15 days", fmtN(soma(expJan, (r) => r.sacas)), `${qtd(expJan.length, "contract", "contracts")} · US$ ${fmtN(soma(expJan, (r) => r.saldo_usd))} to receive`)}
      ${kpi("Inventory", fmtN(estoqueTot), `${fmtN(dispTot)} bags available · ${idade == null ? "—" : fmtN(idade)} days average age`)}
    </div>
    ${cartao("dFluxo", "Coffee in and out, day by day", "Next 15 days · purchases still to receive, and domestic and export bags still to leave",
      { rotulos: dias.map(diaCurto), unidade: "bags", series: [
        { rotulo: "Purchases in", dados: porDia(comprasJan, "prev_entrega", (r) => r.a_entregar) },
        { rotulo: "Domestic out", dados: porDia(vendasJan, "prev_embarque", (r) => r.a_entregar) },
        { rotulo: "Export out", dados: porDia(expJan, "prev_carga", (r) => r.sacas) }] }, { classe: "qa-s8", alto: 300 })}
    <section class="pos-card qa-s4">
      <div class="pos-card-h"><h2>Inventory by preparation</h2><p class="muted">Bags in stock by breakage class</p></div>
      ${barraSegmentos(classes.map((c) => [rotClasse[c], soma(d.estoque.filter((r) => r.classe === c), (r) => r.sacas)]))}
      <div class="pos-card-h" style="margin-top:8px"><h2>Available to sell</h2><p class="muted">Free lots, same classes</p></div>
      ${barraSegmentos(classes.map((c) => [rotClasse[c], soma(disp.filter((r) => r._e?.classe === c), (r) => r.sacas)]))}
    </section>
    ${cartao("dQual", "Exports to load by quality", "Next 15 days · bags", { rotulos: rkQual.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkQual.map((x) => x[1]) }] }, { classe: "qa-s4" })}
    ${cartao("dCli", "Domestic deliveries by client", "Next 15 days · bags to deliver", { rotulos: rkCli.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkCli.map((x) => x[1]) }] }, { classe: "qa-s4" })}
    ${cartao("dArm", "Inventory by warehouse", "Bags in stock", { rotulos: rkArm.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkArm.map((x) => x[1]) }] }, { classe: "qa-s4" })}
    ${cartao("dPagar", "Purchase payments due, day by day", `Next 15 days · R$ ${fmtN(soma(pagar, (r) => r.valor_final))} in ${qtd(pagar.length, "contract", "contracts")}`,
      { rotulos: dias.map(diaCurto), unidade: "", fmt: (v) => `R$ ${fmtN(v)}`, fmtEixo: (v) => (Math.abs(v) >= 1e6 ? `${fmtN(v / 1e6, 0)}M` : fmtK(v)), series: [{ rotulo: "Final value (R$)", dados: porDia(pagar, "vencimento", (r) => r.valor_final), cor: t.s3 }] }, { classe: "qa-s12", alto: 220 })}
  </div>`;
  await ligarCartoes(alvo);
};

// =====================================================================
// PURCHASES
// =====================================================================
const COLS_COMPRAS = [["prev_entrega", "Exp. delivery", "d"], ["vencimento", "Due", "d"], ["fornecedor", "Supplier", "t"], ["contrato", "Contract", "t"],
  ["sacas", "Bags", "n"], ["a_entregar", "To deliver", "n"], ["padrao", "Quality", "t"], ["bebida", "Cup", "t"], ["pen17", "Screen 17+", "p"],
  ["quebra", "Breakage", "p"], ["limpo", "R$/bag clean", "brl"], ["safra", "Crop", "t"], ["certificador", "Certificate", "t"],
  ["corretor", "Broker", "t"], ["local", "Delivery place", "t"], ["modalidade", "Type", "t"], ["emissao", "Issued", "d"]];
PAINEIS.purchases = (alvo, d) => {
  const hoje = d.hoje;
  const defs = [
    { k: "status", rot: "Status", val: (r) => r.status, rotulo: (v) => (v === "A Receber" ? "To receive" : "Delivered") },
    { k: "padrao", rot: "Quality", val: (r) => r.padrao }, { k: "especie", rot: "Species", val: (r) => r.especie },
    { k: "certificador", rot: "Certificate", val: (r) => r.certificador }, { k: "safra", rot: "Crop", val: (r) => r.safra, ordem: "desc" },
    { k: "corretor", rot: "Broker", val: (r) => r.corretor }, { k: "local", rot: "Delivery place", val: (r) => r.local },
  ];
  const estado = { _buscaEm: (r) => [r.contrato, r.fornecedor] };
  return montar(alvo, { rows: d.compras, defs, estado, busca: "Contract or supplier", corpo: (rows) => {
    const abertos = rows.filter((r) => r.status === "A Receber");
    const atras = abertos.filter((r) => r.prev_entrega && r.prev_entrega < hoje);
    const sem7 = abertos.filter((r) => entre(r.prev_entrega, hoje, somarDias(hoje, 6)));
    const ym = mesDe(hoje), ms = meses(somarMeses(ym, -12), somarMeses(ym, 12));
    const porMes = (f) => ms.map((m) => soma(rows.filter((r) => mesDe(r.vencimento) === m), f));
    const rkQ = ranking(abertos, (r) => r.padrao, (r) => r.a_entregar);
    const rkC = ranking(rows, (r) => r.certificador || "No certificate", (r) => r.sacas, { top: 8 });
    const rkF = ranking(abertos, (r) => r.fornecedor, (r) => r.a_entregar, { top: 10 });
    const contratado = soma(rows, (r) => r.sacas), entregue = soma(rows, (r) => r.entregue);
    return `<div class="pos-kpis qa-s12">
        ${kpi("Bags to receive", fmtN(soma(abertos, (r) => r.a_entregar)), `${qtd(abertos.length, "open contract", "open contracts")}`)}
        ${kpi("Delivered", pct(contratado ? entregue / contratado : null), `${fmtN(entregue)} of ${fmtN(contratado)} bags contracted`)}
        ${kpi("Expected in the next 7 days", fmtN(soma(sem7, (r) => r.a_entregar)), qtd(sem7.length, "contract", "contracts"))}
        ${kpi("Late deliveries", fmtN(soma(atras, (r) => r.a_entregar)), `${qtd(atras.length, "contract", "contracts")} past the expected date`, atras.length ? "alerta" : "")}
      </div>
      ${cartao("cMes", "Contracted vs delivered, by due month", "Last 12 and next 12 months · bags",
        { rotulos: ms.map((m) => fmtMes(m + "-01")), unidade: "bags", series: [{ rotulo: "Contracted", dados: porMes((r) => r.sacas) }, { rotulo: "Delivered", dados: porMes((r) => r.entregue) }] }, { classe: "qa-s8", alto: 300 })}
      ${cartao("cQual", "Still to receive by quality", "Open contracts · bags", { rotulos: rkQ.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkQ.map((x) => x[1]) }] }, { classe: "qa-s4" })}
      ${cartao("cForn", "Largest suppliers to receive from", "Open contracts · bags", { rotulos: rkF.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkF.map((x) => x[1]) }] }, { classe: "qa-s6" })}
      ${cartao("cCert", "Purchases by certificate", "All contracts in the selection · bags", { rotulos: rkC.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkC.map((x) => x[1]) }] }, { classe: "qa-s6" })}
      ${tabela("c7", "Expected in the next 7 days", "Open contracts with more than 10 bags to deliver", COLS_COMPRAS.filter((c) => !["sacas", "emissao", "modalidade"].includes(c[0])),
        sem7.filter((r) => r.a_entregar > 10), { ordem: "prev_entrega", totais: ["a_entregar"] })}
      ${tabela("cTudo", "All contracts", "Late deliveries are marked", COLS_COMPRAS, rows, { ordem: "prev_entrega", desc: true, totais: ["sacas", "a_entregar"],
        marcar: (r) => r.status === "A Receber" && r.prev_entrega && r.prev_entrega < hoje })}`;
  } });
};

// =====================================================================
// INTERNAL MARKET
// =====================================================================
const COLS_VENDAS = [["contrato", "Contract", "t"], ["cliente", "Client", "t"], ["sacas", "Bags", "n"], ["a_entregar", "To deliver", "n"], ["padrao", "Quality", "t"],
  ["peneira", "Screen", "t"], ["bebida", "Cup", "t"], ["prev_embarque", "Exp. shipment", "d"], ["primeiro_venc", "First due", "d"], ["referencia", "Reference", "t"],
  ["corretor", "Broker", "t"], ["unitario", "R$/bag", "brl"], ["modalidade", "Type", "t"], ["emissao", "Issued", "d"]];
PAINEIS.domestic = (alvo, d) => {
  const hoje = d.hoje;
  const defs = [
    { k: "status", rot: "Status", val: (r) => r.status, rotulo: (v) => (v === "A Entregar" ? "To deliver" : "Delivered") },
    { k: "padrao", rot: "Quality", val: (r) => r.padrao }, { k: "peneira", rot: "Screen", val: (r) => r.peneira },
    { k: "especie", rot: "Species", val: (r) => r.especie }, { k: "cliente", rot: "Client", val: (r) => r.cliente }, { k: "corretor", rot: "Broker", val: (r) => r.corretor },
  ];
  const estado = { _buscaEm: (r) => [r.contrato, r.cliente] };
  return montar(alvo, { rows: d.vendas, defs, estado, busca: "Contract or client", corpo: (rows) => {
    const abertos = rows.filter((r) => r.status === "A Entregar");
    const atras = abertos.filter((r) => r.prev_embarque && r.prev_embarque < hoje);
    const ym = mesDe(hoje), ms = meses(somarMeses(ym, -11), somarMeses(ym, 9));
    const porMes = (rs, f) => ms.map((m) => soma(rs.filter((r) => mesDe(r.prev_embarque) === m), f));
    const rkCli = ranking(rows, (r) => r.cliente, (r) => r.sacas, { top: 12 });
    const rkQ = ranking(abertos, (r) => r.padrao, (r) => r.a_entregar);
    return `<div class="pos-kpis qa-s12">
        ${kpi("Bags sold", fmtN(soma(rows, (r) => r.sacas)), qtd(rows.length, "contract", "contracts"))}
        ${kpi("Bags to deliver", fmtN(soma(abertos, (r) => r.a_entregar)), `${qtd(abertos.length, "contract", "contracts")} · R$ ${fmtN(soma(abertos, (r) => r.saldo_reais))}`)}
        ${kpi("Clients", fmtN(new Set(rows.map((r) => r.cliente)).size), "in the selection")}
        ${kpi("Late deliveries", fmtN(soma(atras, (r) => r.a_entregar)), `${qtd(atras.length, "contract", "contracts")} past the expected shipment`, atras.length ? "alerta" : "")}
      </div>
      ${cartao("vMes", "Sold and still to deliver, by expected shipment month", "Last 12 and next 9 months · bags",
        { rotulos: ms.map((m) => fmtMes(m + "-01")), unidade: "bags", series: [{ rotulo: "Sold", dados: porMes(rows, (r) => r.sacas) }, { rotulo: "To deliver", dados: porMes(abertos, (r) => r.a_entregar) }] }, { classe: "qa-s8", alto: 300 })}
      ${cartao("vQual", "Still to deliver by quality", "Bags", { rotulos: rkQ.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkQ.map((x) => x[1]) }] }, { classe: "qa-s4" })}
      ${cartao("vCli", "Bags sold by client", "Largest clients in the selection", { rotulos: rkCli.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkCli.map((x) => x[1]) }] }, { classe: "qa-s12" })}
      ${tabela("vTudo", "Contracts", "Late deliveries are marked", COLS_VENDAS, rows, { ordem: "prev_embarque", desc: true, totais: ["sacas", "a_entregar"],
        marcar: (r) => r.status === "A Entregar" && r.prev_embarque && r.prev_embarque < hoje })}`;
  } });
};

// =====================================================================
// EXPORT SHIPMENTS
// =====================================================================
const COLS_EXP = [["cliente", "Client", "t"], ["contrato", "Contract", "t"], ["referencia", "Client ref.", "t"], ["sacas", "Bags", "n"], ["peso", "Weight (kg)", "n"],
  ["padrao", "Quality", "t"], ["peneira", "Screen", "t"], ["prev_carga", "Exp. loading", "d"], ["embarque", "Shipment", "d"], ["safras", "Crop", "t"],
  ["local", "Stuffing place", "t"], ["certificador", "Certificate", "t"], ["diferencial", "Differential", "n2"], ["status_amostra", "Sample", "t"],
  ["envio_amostra", "Sample sent", "d"], ["qualidade", "Description", "t"], ["oic", "ICO", "t"], ["dead_cafe", "Coffee deadline", "d"], ["data_saida", "Exit", "d"],
  ["destino", "Destination", "t"], ["chegada_destino", "Arrival", "d"], ["booking", "Booking", "t"], ["armador", "Carrier", "t"], ["navio", "Vessel", "t"],
  ["lotes_entregues", "Lots delivered", "t"], ["padrao_lotes", "Quality of lots", "t"], ["origem_lote", "Lot origin", "t"], ["emissao", "Issued", "d"], ["containers", "Containers", "n"]];
PAINEIS.exports = (alvo, d) => {
  const hoje = d.hoje;
  const rows0 = d.exportacao.map((r) => ({ ...r, cliente: r.cliente ?? r.importador }));
  const defs = [
    { k: "status_embarque", rot: "Status", val: (r) => r.status_embarque },
    { k: "padrao", rot: "Quality", val: (r) => r.padrao }, { k: "peneira", rot: "Screen", val: (r) => r.peneira },
    { k: "especie", rot: "Species", val: (r) => r.especie }, { k: "certificador", rot: "Certificate", val: (r) => r.certificador },
    { k: "cliente", rot: "Client", val: (r) => r.cliente }, { k: "local", rot: "Stuffing place", val: (r) => r.local },
    { k: "mes", rot: "Shipment month", val: (r) => mesDe(r.embarque), rotulo: (v) => fmtMes(v + "-01"), ordem: "desc" },
  ];
  const estado = { _buscaEm: (r) => [r.contrato, r.referencia, r.cliente, r.importador] };
  return montar(alvo, { rows: rows0, defs, estado, busca: "Contract, client or reference", corpo: (rows) => {
    const aEmb = rows.filter((r) => r.status_embarque === "To be Shipped");
    const emb = rows.filter((r) => r.status_embarque === "Shipped");
    const prox7 = aEmb.filter((r) => entre(r.prev_carga, hoje, somarDias(hoje, 6)));
    const atras = aEmb.filter((r) => r.prev_carga && r.prev_carga < hoje);
    const semData = aEmb.filter((r) => !r.prev_carga);
    const ym = mesDe(hoje), ms = meses(somarMeses(ym, -11), somarMeses(ym, 6));
    const porMes = (f) => ms.map((m) => soma(rows.filter((r) => mesDe(r.embarque) === m), f));
    const dias7 = Array.from({ length: 7 }, (_, i) => somarDias(hoje, i));
    const rkQ = ranking(aEmb, (r) => r.padrao, (r) => r.sacas);
    const rkA = ranking(aEmb, (r) => r.status_amostra || "No status", (r) => 1, { top: 8 });
    const bl = aEmb.filter((r) => r.com_bl), book = aEmb.filter((r) => !r.com_bl && r.booking), semBook = aEmb.filter((r) => !r.com_bl && !r.booking);
    return `<div class="pos-kpis qa-s12">
        ${kpi("Bags to ship", fmtN(soma(aEmb, (r) => r.sacas)), qtd(aEmb.length, "contract", "contracts"))}
        ${kpi("Bags shipped", fmtN(soma(emb, (r) => r.sacas)), qtd(emb.length, "contract", "contracts"))}
        ${kpi("Loading in the next 7 days", fmtN(soma(prox7, (r) => r.sacas)), qtd(prox7.length, "contract", "contracts"))}
        ${kpi("Loading date passed", fmtN(soma(atras, (r) => r.sacas)), `${qtd(atras.length, "contract", "contracts")} not shipped yet`, atras.length ? "alerta" : "")}
        ${kpi("No loading date", fmtN(soma(semData, (r) => r.sacas)), `${qtd(semData.length, "contract", "contracts")} to ship`)}
      </div>
      ${cartao("eMes", "Contracted vs shipped, by shipment month", "Last 12 and next 6 months · bags",
        { rotulos: ms.map((m) => fmtMes(m + "-01")), unidade: "bags", series: [{ rotulo: "Contracted", dados: porMes((r) => r.sacas) }, { rotulo: "Shipped", dados: porMes((r) => r.saida) }] }, { classe: "qa-s8", alto: 300 })}
      ${cartao("e7", "Loading in the next 7 days", "Bags not shipped yet, by expected loading date",
        { rotulos: dias7.map(diaCurto), unidade: "bags", series: [{ rotulo: "Bags", dados: dias7.map((x) => soma(prox7.filter((r) => r.prev_carga === x), (r) => r.sacas)) }] }, { classe: "qa-s4", alto: 300 })}
      ${cartao("eQual", "To ship by quality", "Bags not shipped yet", { rotulos: rkQ.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkQ.map((x) => x[1]) }] }, { classe: "qa-s4" })}
      ${cartao("eAmostra", "Samples of contracts to ship", "Number of contracts by sample status", { rotulos: rkA.map((x) => x[0]), horizontal: true, unidade: "contracts", series: [{ rotulo: "Contracts", dados: rkA.map((x) => x[1]) }] }, { classe: "qa-s4" })}
      <section class="pos-card qa-s4">
        <div class="pos-card-h"><h2>Booking of contracts to ship</h2><p class="muted">Number of contracts</p></div>
        ${barraSegmentos([["BL issued", bl.length], ["Booked, no BL yet", book.length], ["No booking", semBook.length]], "contracts")}
      </section>
      ${tabela("e7t", "To be stuffed — next 7 days", "", COLS_EXP.filter((c) => !["destino", "armador", "lotes_entregues", "padrao_lotes", "origem_lote", "emissao", "containers"].includes(c[0])),
        prox7, { ordem: "prev_carga", totais: ["sacas", "peso"] })}
      ${tabela("eTudo", "Shipments", "Contracts whose loading date passed without shipment are marked", COLS_EXP, rows, { ordem: "prev_carga", desc: true, totais: ["sacas", "peso", "containers"],
        marcar: (r) => r.status_embarque === "To be Shipped" && r.prev_carga && r.prev_carga < hoje })}`;
  } });
};

// =====================================================================
// INVENTORY
// =====================================================================
const FAIXAS_IDADE = [[0, 30, "Up to 30 days"], [31, 60, "31–60 days"], [61, 90, "61–90 days"], [91, 180, "91–180 days"], [181, Infinity, "Over 180 days"]];
PAINEIS.inventory = (alvo, d) => {
  const disponiveis = new Map(d.lotes.map((l) => [l.lote, l]));
  const rows0 = d.estoque.map((r) => ({ ...r, disp: disponiveis.get(r.lote)?.sacas ?? 0 }));
  const defs = [
    { k: "padrao", rot: "Quality", val: (r) => r.padrao }, { k: "classe", rot: "Preparation", val: (r) => r.classe },
    { k: "armazem", rot: "Warehouse", val: (r) => r.armazem }, { k: "certificador", rot: "Certificate", val: (r) => r.certificador },
    { k: "especie", rot: "Species", val: (r) => r.especie }, { k: "safra", rot: "Crop", val: (r) => r.safra, ordem: "desc" },
  ];
  const estado = { _buscaEm: (r) => [r.lote, r.contrato_guia, r.contrato] };
  const cols = [["lote", "Lot", "t"], ["contrato_guia", "Contract / order", "t"], ["data_lote", "Lot date", "d"], ["dias", "Days in stock", "n"], ["volumes", "Volumes", "n"],
    ["sacas", "Bags", "n"], ["disp", "Available", "n"], ["peso", "Weight (kg)", "n"], ["padrao", "Quality", "t"], ["classe", "Preparation", "t"], ["bebida", "Cup", "t"],
    ["peneiras", "Screens", "t"], ["certificador", "Certificate", "t"], ["safra", "Crop", "t"], ["armazem", "Warehouse", "t"]];
  return montar(alvo, { rows: rows0, defs, estado, busca: "Lot, contract or service order", corpo: (rows) => {
    const t = tema();
    const tot = soma(rows, (r) => r.sacas), disp = soma(rows, (r) => r.disp);
    const idadeMedia = rows.length ? soma(rows, (r) => r.dias) / rows.length : null;
    const idadePond = tot ? soma(rows, (r) => (r.dias ?? 0) * (r.sacas ?? 0)) / tot : null;
    const velhos = rows.filter((r) => r.dias > 90);
    const qual = ranking(rows, (r) => r.padrao, (r) => r.sacas, { top: 14 }).map((x) => x[0]);
    const porQual = (f) => qual.map((q) => soma(rows.filter((r) => (r.padrao || "(blank)") === q || (q === "Other" && !qual.slice(0, -1).includes(r.padrao || "(blank)"))), f));
    const faixas = FAIXAS_IDADE.map(([a, b]) => soma(rows.filter((r) => r.dias >= a && r.dias <= b), (r) => r.sacas));
    const rkArm = ranking(rows, (r) => r.armazem, (r) => r.sacas, { top: 8 });
    const lotesDisp = rows.filter((r) => r.disp > 0);
    return `<div class="pos-kpis qa-s12">
        ${kpi("Bags in stock", fmtN(tot), qtd(rows.length, "lot", "lots"))}
        ${kpi("Available to sell", fmtN(disp), `${pct(tot ? disp / tot : null)} of the stock · ${qtd(lotesDisp.length, "lot", "lots")}`)}
        ${kpi("Average age", `${idadeMedia == null ? "—" : fmtN(idadeMedia)} days`, `${idadePond == null ? "—" : fmtN(idadePond)} days weighted by bags`)}
        ${kpi("Lots older than 90 days", fmtN(soma(velhos, (r) => r.sacas)), `bags in ${qtd(velhos.length, "lot", "lots")}`, velhos.length ? "alerta" : "")}
      </div>
      ${cartao("iQual", "Stock and availability by quality", "Bags in stock and bags in free lots", { rotulos: qual, horizontal: true, unidade: "bags",
        series: [{ rotulo: "In stock", dados: porQual((r) => r.sacas) }, { rotulo: "Available", dados: porQual((r) => r.disp) }] }, { classe: "qa-s7" })}
      ${cartao("iIdade", "How long the coffee has been in stock", "Bags by days since the lot was created",
        { rotulos: FAIXAS_IDADE.map((f) => f[2]), unidade: "bags", series: [{ rotulo: "Bags", dados: faixas, cores: FAIXAS_IDADE.map((_, i) => tom(t.s1, t.sup, 0.3 + i * 0.175)) }] }, { classe: "qa-s5", alto: 280 })}
      ${cartao("iArm", "Stock by warehouse", "Bags", { rotulos: rkArm.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkArm.map((x) => x[1]) }] }, { classe: "qa-s5" })}
      <section class="pos-card qa-s7">
        <div class="pos-card-h"><h2>Stock by preparation</h2><p class="muted">Ready = 0% breakage · Unscreened = some breakage · Consumption = 100% breakage</p></div>
        ${barraSegmentos(["PRONTO", "BICA CORRIDA", "CONSUMO"].map((c) => [{ PRONTO: "Ready", "BICA CORRIDA": "Unscreened", CONSUMO: "Consumption" }[c], soma(rows.filter((r) => r.classe === c), (r) => r.sacas)]))}
      </section>
      ${tabela("iLotes", "Lots in stock", "Lots older than 90 days are marked", cols, rows, { ordem: "data_lote", desc: true, totais: ["volumes", "sacas", "disp", "peso"], marcar: (r) => r.dias > 90 })}`;
  } });
};

// =====================================================================
// SERVICE ORDERS (guias de serviço + despejo x resultado)
// =====================================================================
PAINEIS.services = (alvo, d) => {
  const defs = [
    { k: "ano", rot: "Year", val: (r) => r.fechamento?.slice(0, 4), ordem: "desc" },
    { k: "mes", rot: "Month", val: (r) => mesDe(r.fechamento), rotulo: (v) => fmtMes(v + "-01"), ordem: "desc" },
    { k: "armazem", rot: "Warehouse", val: (r) => r.armazem }, { k: "servicos", rot: "Service", val: (r) => r.servicos },
    { k: "finalidade", rot: "Purpose", val: (r) => r.finalidade }, { k: "padrao", rot: "Quality", val: (r) => r.padrao },
  ];
  const estado = { ano: d.hoje.slice(0, 4), _buscaEm: (r) => [r.guia, r.contratos] };
  const cols = [["guia", "Order", "t"], ["fechamento", "Closed", "d"], ["finalidade", "Purpose", "t"], ["servicos", "Service", "t"], ["padrao", "Quality", "t"],
    ["entrada", "Bags in", "n"], ["saida", "Bags out", "n"], ["catado", "Picked (catado)", "n"], ["consumo", "Consumption", "n"],
    ["consumo_ent", "Consumption %", "p"], ["quebra", "Breakage %", "p"], ["armazem", "Warehouse", "t"], ["contratos", "Contracts", "t"]];
  return montar(alvo, { rows: d.guias, defs, estado, busca: "Order or contract", corpo: (rows) => {
    const t = tema();
    const guias = new Set(rows.map((r) => r.guia));
    const ent = soma(rows, (r) => r.entrada), sai = soma(rows, (r) => r.saida);
    const ms = [...new Set(rows.map((r) => mesDe(r.fechamento)).filter(Boolean))].sort().slice(-18);
    const rkS = ranking(rows, (r) => r.servicos, (r) => r.entrada, { top: 10 });
    const rkA = ranking(rows, (r) => r.armazem, (r) => r.entrada, { top: 8 });
    // despejo x resultado das mesmas guias: o que entrou (despejado) e o que saiu por qualidade
    const desp = d.despejo.filter((x) => guias.has(x.instrucao));
    const quals = ranking(desp, (x) => x.padrao, (x) => Math.abs(x.sacas), { top: 14, outros: "Other" }).map((x) => x[0]);
    const doQual = (x, q) => (x.padrao || "(blank)") === q || (q === "Other" && !quals.slice(0, -1).includes(x.padrao || "(blank)"));
    const despejado = quals.map((q) => -soma(desp.filter((x) => x.operacao === "DESPEJO" && doQual(x, q)), (x) => x.sacas));
    const resultado = quals.map((q) => soma(desp.filter((x) => x.operacao === "RESULTADO" && doQual(x, q)), (x) => x.sacas));
    return `<div class="pos-kpis qa-s12">
        ${kpi("Service orders closed", fmtN(guias.size), "in the selection")}
        ${kpi("Bags in", fmtN(ent), "dumped into the orders")}
        ${kpi("Bags out", fmtN(sai), `${pct(ent ? sai / ent : null, 1)} yield`)}
        ${kpi("Picked + consumption", fmtN(soma(rows, (r) => r.catado) + soma(rows, (r) => r.consumo)), `${fmtN(soma(rows, (r) => r.catado))} picked · ${fmtN(soma(rows, (r) => r.consumo))} consumption`)}
      </div>
      ${cartao("gMes", "Bags processed by month", "Bags in and out of closed orders",
        { rotulos: ms.map((m) => fmtMes(m + "-01")), unidade: "bags", series: [{ rotulo: "In", dados: ms.map((m) => soma(rows.filter((r) => mesDe(r.fechamento) === m), (r) => r.entrada)) },
          { rotulo: "Out", dados: ms.map((m) => soma(rows.filter((r) => mesDe(r.fechamento) === m), (r) => r.saida)) }] }, { classe: "qa-s8", alto: 300 })}
      ${cartao("gServ", "By service", "Bags in", { rotulos: rkS.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkS.map((x) => x[1]) }] }, { classe: "qa-s4" })}
      ${cartao("gQual", "Dumped vs result, by quality", "What went into the orders (left) and what came out (right) · bags",
        { rotulos: quals, horizontal: true, empilhado: true, unidade: "bags", fmt: (v) => fmtN(Math.abs(v)), fmtEixo: (v) => fmtK(Math.abs(v)),
          series: [{ rotulo: "Dumped", dados: despejado, cor: t.neg }, { rotulo: "Result", dados: resultado, cor: t.pos }] }, { classe: "qa-s8" })}
      ${cartao("gArm", "By warehouse", "Bags in", { rotulos: rkA.map((x) => x[0]), horizontal: true, unidade: "bags", series: [{ rotulo: "Bags", dados: rkA.map((x) => x[1]) }] }, { classe: "qa-s4" })}
      ${tabela("gTudo", "Service orders", "", cols, rows, { ordem: "fechamento", desc: true, totais: ["entrada", "saida", "catado", "consumo"] })}`;
  } });
};

// =====================================================================
// PURCHASE x ARRIVAL — o lote chegou com a qualidade do contrato?
// =====================================================================
PAINEIS.arrivals = (alvo, d) => {
  const rows0 = d.chegada.map((r) => {
    const dif = (a, b) => (a == null || b == null ? null : a - b);
    const lg = dif(r.lg_lote, r.lg_ctr);
    return { ...r, lg_dif: lg, lg_sacas: lg == null || r.sacas == null ? null : (r.sacas * lg) / 100,
      quebra_dif: dif(r.quebra_lote, r.quebra_ctr), mesmo_padrao: !r.padrao_ctr || !r.padrao_lote || r.padrao_ctr === r.padrao_lote,
      // a bebida do lote pode vir com a cor junto ("DURO VERDE" x "DURO"): conta o começo
      mesma_bebida: !r.bebida_ctr || !r.bebida_lote || r.bebida_lote.startsWith(r.bebida_ctr) };
  });
  for (const r of rows0) r.conforme = r.mesmo_padrao && r.mesma_bebida && !(r.lg_dif > 0) && !(r.quebra_dif > 0);
  const defs = [
    { k: "ano", rot: "Year", val: (r) => r.entrada?.slice(0, 4), ordem: "desc" },
    { k: "mes", rot: "Month", val: (r) => mesDe(r.entrada), rotulo: (v) => fmtMes(v + "-01"), ordem: "desc" },
    { k: "filial", rot: "Branch", val: (r) => r.filial }, { k: "fornecedor", rot: "Supplier", val: (r) => r.fornecedor },
    { k: "padrao_ctr", rot: "Contract quality", val: (r) => r.padrao_ctr },
    { k: "conf", rot: "Result", val: (r) => (r.conforme ? "As contracted" : "Deviation"), },
  ];
  const estado = { ano: d.hoje.slice(0, 4), _buscaEm: (r) => [r.contrato, r.lote, r.fornecedor] };
  const cols = [["entrada", "Arrival", "d"], ["lote", "Lot", "t"], ["contrato", "Contract", "t"], ["fornecedor", "Supplier", "t"], ["sacas", "Bags", "n"],
    ["padrao_ctr", "Quality (contract)", "t"], ["padrao_lote", "Quality (lot)", "t"], ["bebida_ctr", "Cup (contract)", "t"], ["bebida_lote", "Cup (lot)", "t"],
    ["quebra_ctr", "Breakage % (contract)", "p"], ["quebra_lote", "Breakage % (lot)", "p"], ["lg_ctr", "LG % (contract)", "p"], ["lg_lote", "LG % (lot)", "p"],
    ["lg_dif", "LG diff (pp)", "n2"], ["lg_sacas", "LG diff (bags)", "n"], ["filial", "Branch", "t"], ["safra", "Crop", "t"]];
  return montar(alvo, { rows: rows0, defs, estado, busca: "Contract, lot or supplier", corpo: (rows) => {
    const t = tema();
    const conf = rows.filter((r) => r.conforme), desv = rows.filter((r) => !r.conforme);
    const sacas = soma(rows, (r) => r.sacas);
    const lgSacas = soma(rows, (r) => r.lg_sacas);
    const ms = [...new Set(rows.map((r) => mesDe(r.entrada)).filter(Boolean))].sort().slice(-18);
    const taxa = ms.map((m) => { const x = rows.filter((r) => mesDe(r.entrada) === m); return x.length ? (100 * x.filter((r) => r.conforme).length) / x.length : null; });
    // fornecedores com mais lotes fora do contratado (só quem entregou 3+ lotes)
    const porForn = new Map();
    for (const r of rows) { const k = r.fornecedor || "(no supplier)"; const a = porForn.get(k) ?? { n: 0, d: 0 }; a.n++; if (!r.conforme) a.d++; porForn.set(k, a); }
    const forn = [...porForn].filter(([, a]) => a.d).sort((a, b) => b[1].d - a[1].d || b[1].d / b[1].n - a[1].d / a[1].n).slice(0, 12);
    // matriz qualidade do contrato x qualidade do lote
    const qs = ranking(rows, (r) => r.padrao_ctr, (r) => r.sacas, { top: 10 }).map((x) => x[0]).filter((q) => q !== "Other");
    const qsL = [...new Set([...qs, ...ranking(rows, (r) => r.padrao_lote, (r) => r.sacas, { top: 10 }).map((x) => x[0]).filter((q) => q !== "Other")])];
    const cel = new Map();
    for (const r of rows) { const k = `${r.padrao_ctr}\u0001${r.padrao_lote}`; cel.set(k, (cel.get(k) ?? 0) + (r.sacas ?? 0)); }
    const maxCel = Math.max(1, ...[...cel.values()]);
    const motivos = [["Different quality", rows.filter((r) => !r.mesmo_padrao).length], ["Different cup", rows.filter((r) => !r.mesma_bebida).length],
      ["More low grade (LG)", rows.filter((r) => r.lg_dif > 0).length], ["More breakage", rows.filter((r) => r.quebra_dif > 0).length]].sort((a, b) => b[1] - a[1]);
    return `<div class="pos-kpis qa-s12">
        ${kpi("Lots received", fmtN(rows.length), `${fmtN(sacas)} bags`)}
        ${kpi("Arrived as contracted", pct(rows.length ? conf.length / rows.length : null), `${qtd(conf.length, "lot", "lots")} with quality, cup, LG and breakage within contract`)}
        ${kpi("Lots with deviation", fmtN(desv.length), `${fmtN(soma(desv, (r) => r.sacas))} bags`, desv.length ? "alerta" : "")}
        ${kpi("Low grade above contract", fmtN(lgSacas), "bags of LG beyond the contracted % (net)")}
      </div>
      ${cartao("aTaxa", "Lots arriving as contracted, by month", "% of lots with quality, cup, LG and breakage within contract",
        { rotulos: ms.map((m) => fmtMes(m + "-01")), linha: true, unidade: "", fmt: (v) => `${fmtN(v, 1)}%`, fmtEixo: (v) => `${v}%`, min: 0, max: 100,
          series: [{ rotulo: "As contracted", dados: taxa }] }, { classe: "qa-s8", alto: 280 })}
      ${cartao("aMot", "Why lots deviate", "Number of lots by reason (a lot can have more than one)", { rotulos: motivos.map((x) => x[0]), horizontal: true, unidade: "lots",
        series: [{ rotulo: "Lots", dados: motivos.map((x) => x[1]), cor: t.s2 }] }, { classe: "qa-s4" })}
      ${cartao("aForn", "Suppliers with the most lots out of contract", "Lots with any deviation · in brackets, the share of that supplier's lots",
        { rotulos: forn.map(([k, a]) => `${cortar(k, 24)} (${fmtN((100 * a.d) / a.n)}% of ${a.n})`), horizontal: true, unidade: "lots",
          series: [{ rotulo: "Lots out of contract", dados: forn.map(([, a]) => a.d), cor: t.s2 }] }, { classe: "qa-s6" })}
      <section class="pos-card qa-s6">
        <div class="pos-card-h"><h2>Contract quality vs arrival quality</h2><p class="muted">Bags · rows are the contracted quality, columns the quality of the lot that arrived; the diagonal is on spec</p></div>
        ${qs.length ? `<div class="pos-tabela"><table class="tabela tabela-num qa-mapa"><thead><tr><th>Contract ↓ / Lot →</th>${qsL.map((q) => `<th>${esc(q)}</th>`).join("")}</tr></thead><tbody>
          ${qs.map((a) => `<tr><td>${esc(a)}</td>${qsL.map((b) => { const v = cel.get(`${a}\u0001${b}`) ?? 0;
            return `<td class="num${a === b ? " qa-diag" : ""}" style="${v ? `background:${tom(a === b ? t.s1 : t.s2, t.sup, 0.12 + 0.6 * Math.sqrt(v / maxCel))}` : ""}" title="${esc(`${a} → ${b}: ${fmtN(v)} bags`)}">${v ? fmtK(v) : ""}</td>`; }).join("")}</tr>`).join("")}
        </tbody></table></div>` : `<p class="muted qa-vazio">Nothing for this selection.</p>`}
      </section>
      ${tabela("aLotes", "Lots received", "Lots with any deviation from the contract are marked", cols, rows, { ordem: "entrada", desc: true, totais: ["sacas", "lg_sacas"], marcar: (r) => !r.conforme })}`;
  } });
};
