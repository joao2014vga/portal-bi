// Position: painéis nativos do portal a partir da planilha diária
// "Brascof Position Overview" (.xlsm). O upload lê a planilha no próprio
// navegador (sem macros), extrai os resumos e os contratos em aberto e grava
// tudo no Supabase de uma vez (função bi_position_publicar).
// Os mesmos painéis podem vir do Digisul (fonte "api"): o servidor brascof-api
// recalcula com position-calc.js e grava pela função bi_position_publicar_api.
//
// Painéis (link cadastrado em bi_dashboards):
//   portal:position-overview   posição por mês de vencimento + variação do dia
//   portal:position-physical   posição física por mês e por qualidade
//   portal:position-contracts  contratos em aberto, contrato a contrato
import { esc, $, $$, icon, toast, modal, tempoRelativo, dataBR } from "./ui.js";
import {
  ABAS, COLS_TERMM, norm, num, arred, montarPosition, extrairModelo, extrairFuturos, aplicarPtax,
  prazoFixacao, alertasFixacao, textoAlertaFixacao, CAMPO_MES, ALERTA_DIAS, AVISO_DIAS,
} from "./position-calc.js";
import { t as tr, LOCALE, IDIOMA } from "./i18n.js";

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm";

export const ehPainelPosition = (link) => /^portal:position-/.test(link ?? "");

// =====================================================================
// LEITURA DA PLANILHA (o cálculo e as regras ficam em position-calc.js)
// =====================================================================
let xlsxPromise;
function carregarXlsx() {
  xlsxPromise ??= new Promise((ok, falha) => {
    if (window.XLSX) return ok(window.XLSX);
    const s = document.createElement("script");
    s.src = XLSX_URL;
    s.onload = () => ok(window.XLSX);
    s.onerror = () => { xlsxPromise = null; falha(new Error("Unable to load the spreadsheet reader. Check your connection.")); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}

// Aba como matriz [linha][coluna] a partir de A1 (células com erro viram null)
function grade(XLSX, ws) {
  if (!ws?.["!ref"]) return [];
  const r = XLSX.utils.decode_range(ws["!ref"]);
  const linhas = [];
  for (let R = 0; R <= r.e.r; R++) {
    const l = new Array(r.e.c + 1).fill(null);
    for (let C = r.s.c; C <= r.e.c; C++) {
      const c = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (c && c.t !== "e") l[C] = c.v;
    }
    linhas.push(l);
  }
  return linhas;
}

// Lê a planilha no navegador (sem macros): resumo e contratos com os valores
// calculados pelo Excel e, junto, o modelo das fórmulas + futuros que a
// sincronização pela API usa. Uma planilha só com a aba OpenFutures atualiza só os futuros.
export async function lerPlanilhaPosition(file) {
  const XLSX = await carregarXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), {
    type: "array", sheets: [...Object.values(ABAS), "OpenFutures", "List"], cellFormula: true, cellHTML: false, cellText: false, cellStyles: false,
  });
  if (!wb.Sheets[ABAS.termm] && wb.Sheets.OpenFutures) return { futuros: extrairFuturos(XLSX, wb) };
  const faltam = Object.values(ABAS).filter((n) => !wb.Sheets[n]);
  if (faltam.length) throw new Error(`Sheet(s) not found: ${faltam.join(", ")}. Is this the Position Overview spreadsheet?`);
  // cada aba vira matriz uma vez só (vendas e expsales, por exemplo, usam a mesma)
  const grades = new Map();
  const gAba = (nome) => (grades.has(nome) ? grades.get(nome) : grades.set(nome, grade(XLSX, wb.Sheets[nome])).get(nome));
  const { data_ref, resumo, detalhes } = montarPosition(gAba);
  const avisos = [];
  let modelo = null;
  try { modelo = extrairModelo(XLSX, wb); }
  catch (e) { avisos.push(`The Digisul update could not read this spreadsheet's formulas: ${e.message}`); }
  // receita em R$: PTAX de compra D-1 de cada embarque (se o Banco Central não responder, segue sem)
  try {
    const semPtax = await aplicarPtax(detalhes.vendas);
    if (semPtax) avisos.push(`${semPtax} shipments without PTAX.`);
  } catch {
    avisos.push("PTAX could not be loaded from the Central Bank — revenue in R$ will be missing for this upload.");
  }
  return { data_ref, resumo, detalhes, modelo, avisos };
}

const hojeIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// =====================================================================
// FORMATAÇÃO E GRÁFICOS
// =====================================================================
const fmtN = (v, dec = 0) => (v == null ? "—" : Number(v).toLocaleString(LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const fmtSinal = (v) => (v > 0 ? "+" : "") + fmtN(v);
// mês curto: "Dec-26" em inglês, "Dez/26" em português
const MESES_CURTOS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMes = (iso) => (iso ? `${tr(MESES_CURTOS[Number(iso.slice(5, 7)) - 1])}${IDIOMA === "pt" ? "/" : "-"}${iso.slice(2, 4)}` : "—");
const fmtData = (iso) => (iso ? dataBR(iso + "T12:00:00") : "—");
const fmtK = (v) => (Math.abs(v) >= 1000 ? `${fmtN(v / 1000, Math.abs(v) >= 10000 ? 0 : 1)}k` : fmtN(v));

const NOME_GRUPO = { arabica: "Arabica", robusta: "Robusta", exportable: "Exportable", lowgrade: "Low Grade" };

let chartPromise;
const carregarChart = () => (chartPromise ??= import(CHART_URL).then((m) => { m.Chart.register(...m.registerables); return m.Chart; }));
let graficos = [];
function limparGraficos() { graficos.forEach((c) => c.destroy()); graficos = []; }

// cores e tinta vêm das variáveis do tema (claro/escuro) no momento do desenho
function tema() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    s1: v("--serie-1"), s2: v("--serie-2"), s3: v("--serie-3"), tinta: v("--texto"), tinta2: v("--texto-2"),
    muda: v("--texto-3"), grade: v("--borda"), sup: v("--sup"),
  };
}

// Barras empilhadas (componentes) + linha (saldo), um único eixo em sacas
async function graficoBarrasLinha(canvas, { meses, series, linha }) {
  const Chart = await carregarChart();
  const t = tema();
  const cores = [t.s1, t.s3, t.s2];
  const c = new Chart(canvas, {
    data: {
      labels: meses.map(fmtMes),
      datasets: [
        { type: "line", label: tr(linha.rotulo), data: linha.dados, borderColor: t.tinta, backgroundColor: t.tinta, borderWidth: 2,
          pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: t.tinta, pointBorderColor: t.sup, pointBorderWidth: 2, tension: 0, order: 0 },
        ...series.map((s, i) => ({
          type: "bar", label: tr(s.rotulo), data: s.dados, backgroundColor: cores[i], borderColor: t.sup, borderWidth: 1,
          borderRadius: 3, borderSkipped: false, stack: "fisico", order: 1, maxBarThickness: 30,
        })),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { stacked: true, grid: { color: t.grade }, border: { display: false },
          ticks: { color: t.muda, font: { size: 11 }, callback: (v) => fmtK(v) },
          title: { display: true, text: tr("bags (60 kg)"), color: t.muda, font: { size: 11 } } },
      },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtN(ctx.raw)} ${tr("bags")}` } },
      },
    },
  });
  graficos.push(c);
}

async function graficoLinha(canvas, { rotulos, dados, rotulo }) {
  const Chart = await carregarChart();
  const t = tema();
  const c = new Chart(canvas, {
    type: "line",
    data: { labels: rotulos, datasets: [{ label: tr(rotulo), data: dados, borderColor: t.s1, backgroundColor: t.s1, borderWidth: 2,
      pointRadius: 3, pointHoverRadius: 5, pointBorderColor: t.sup, pointBorderWidth: 2, tension: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 }, callback: (v) => fmtK(v) } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${tr(rotulo)}: ${fmtN(ctx.raw)} ${tr("bags")}` } } },
    },
  });
  graficos.push(c);
}

// Botões de escolha (segmented control); `ao` recebe a chave escolhida
function segmentos(id, opcoes, atual) {
  return `<div class="seg" role="tablist" id="${id}">${opcoes.map(([k, t]) =>
    `<button type="button" role="tab" data-k="${k}" class="${k === atual ? "on" : ""}" aria-selected="${k === atual}">${esc(t)}</button>`).join("")}</div>`;
}
function ligarSegmentos(raiz, id, ao) {
  $$(`#${id} button`, raiz).forEach((b) => b.addEventListener("click", () => ao(b.dataset.k)));
}

const celNum = (v, { forte = false } = {}) =>
  `<td class="num ${v < 0 ? "neg" : ""} ${forte ? "forte" : ""}">${v == null ? "—" : v === 0 ? `<span class="zero">–</span>` : fmtN(v)}</td>`;

// =====================================================================
// PAINÉIS
// =====================================================================
// Ponto de entrada: monta o painel `link` dentro de `alvo`.
// ctx = { api, gerente (pode publicar), admin, recarregar }
// Fonte dos números: a oficial (bi_config) para todos; quem publica pode alternar
// entre planilha e API nesta sessão do navegador, para conferir as duas.
const CHAVE_FONTE = "bi-position-fonte";
const fonteVista = () => { try { return sessionStorage.getItem(CHAVE_FONTE); } catch { return null; } };
const guardarFonteVista = (f) => { try { sessionStorage.setItem(CHAVE_FONTE, f); } catch { /* sem armazenamento: fica a oficial */ } };
const NOME_FONTE = { planilha: "Spreadsheet", api: "Digisul API" };

export async function renderPosition(link, alvo, ctx) {
  limparGraficos();
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading Position…</div>`;
  let carga, oficial, fonte;
  try {
    oficial = await ctx.api.positionFonte();
    fonte = (ctx.gerente && fonteVista()) || oficial;
    carga = await ctx.api.positionUltima(fonte);
  } catch (e) {
    alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Position data is not available</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  // a mesma API, presa à fonte que está na tela
  const api = {
    ...ctx.api, positionDetalhe: (tipos) => ctx.api.positionDetalhe(tipos, fonte), positionHistorico: () => ctx.api.positionHistorico(fonte),
    // dados que só existem pela API (logística), qualquer que seja a fonte na tela
    positionDetalheApi: (tipos) => ctx.api.positionDetalhe(tipos, "api"),
  };
  const c = { ...ctx, api, fonte, oficial };
  const topo = barraTopo(carga, c);
  if (!carga) {
    alvo.innerHTML = `<div class="pos">${topo}<div class="vazio">${icon("chart")}<h3>${fonte === "api" ? "No Digisul update yet" : "No Position uploaded yet"}</h3>
      <p>${!ctx.gerente ? "The BI team has not published the Position yet."
        : fonte === "api" ? "Click “Update now” to build these views from Digisul. The spreadsheet must have been uploaded once (its formulas and futures are used)."
        : "Upload the daily Position Overview spreadsheet to build these views."}</p></div></div>`;
    ligarTopo(alvo, c);
    return;
  }
  const painel = {
    "portal:position-overview": painelOverview, "portal:position-physical": painelFisica, "portal:position-contracts": painelContratos,
    "portal:position-sales": painelVendas, "portal:position-purchases": painelCompras, "portal:position-diffs": painelDiffs,
  }[link];
  if (!painel) { alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Unknown Position view</h3></div>`; return; }
  alvo.innerHTML = `<div class="pos">${topo}<div id="posCorpo"></div></div>`;
  ligarTopo(alvo, c);
  await painel($("#posCorpo", alvo), carga, c);
}

function barraTopo(carga, ctx) {
  const api = ctx.fonte === "api";
  const quando = !carga ? "" : api
    ? `updated from Digisul ${tempoRelativo(carga.created_at)}${carga.enviado_por === "Manual" ? " (manual)" : ""}`
    : `uploaded ${tempoRelativo(carga.created_at)}${carga.enviado_por ? ` by ${carga.enviado_por}` : ""}`;
  return `<div class="pos-topo">
    <div class="pos-data">${icon("clock")}${carga
      ? `<span>Position as of <strong>${esc(fmtData(carga.data_ref))}</strong> · ${esc(quando)}</span>`
      : `<span>${api ? "No Digisul update yet" : "No Position uploaded yet"}</span>`}<span class="muted">· all figures in 60 kg bags</span></div>
    ${ctx.gerente ? `<div class="pos-acoes">
      ${segmentos("posFonte", Object.entries(NOME_FONTE).map(([k, n]) => [k, k === ctx.oficial ? `${n} · official` : n]), ctx.fonte)}
      <button class="btn" id="posSync" title="Fetch Digisul and recalculate now">${icon("refresh")}<span>Update now</span></button>
      <button class="btn btn-primary" id="posUpload">${icon("upload")}<span>Upload Position</span></button>
    </div>` : ""}
  </div>`;
}

function ligarTopo(alvo, ctx) {
  ligarSegmentos(alvo, "posFonte", (f) => { guardarFonteVista(f); ctx.recarregar(); });
  $("#posSync", alvo)?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.querySelector("span").textContent = "Updating…";
    try {
      const r = await ctx.api.sincronizarPosition();
      toast(`Position of ${fmtData(r.data_ref)} updated from Digisul.`);
      (r.avisos ?? []).forEach((a) => toast(a, "erro"));
      guardarFonteVista("api");
      ctx.recarregar();
    } catch (e) {
      toast(e.message, "erro");
      b.disabled = false;
      b.querySelector("span").textContent = "Update now";
    }
  });
  $("#posUpload", alvo)?.addEventListener("click", () => modal({
    titulo: "Upload Position",
    botao: "Read and publish",
    corpo: `<p class="muted">Choose the daily <strong>Brascof Position Overview</strong> spreadsheet (.xlsm or .xlsx).
      It is read in your browser — macros are never run — and the Position views are updated for everyone with access.</p>
      <p class="muted">Futures are not in Digisul: when only the futures changed, a file with just the <strong>OpenFutures</strong> sheet is enough.</p>
      <label class="campo"><span>Spreadsheet *</span><input type="file" name="arquivo" accept=".xlsm,.xlsx" required></label>`,
    async onSubmit(f) {
      const file = f.arquivo.files[0];
      if (!file) throw new Error("Please choose the spreadsheet.");
      const lida = await lerPlanilhaPosition(file);
      if (lida.futuros) {
        // só a aba OpenFutures: troca os futuros do modelo e recalcula pela API
        const modelo = await ctx.api.positionModelo();
        if (!modelo) throw new Error("Upload the full Position spreadsheet once before sending only the futures.");
        await ctx.api.salvarPositionModelo({ ...modelo, futuros: lida.futuros }, file.name);
        toast(`Futures updated: ${fmtN(lida.futuros.length)} trades. Recalculating from Digisul…`);
        await ctx.api.sincronizarPosition().then(() => toast("Position updated from Digisul.")).catch((e) => toast(e.message, "erro"));
        ctx.recarregar();
        return;
      }
      // contratos vencidos ou a vencer em 15 dias viram notificação para quem vê o Open Contracts
      await ctx.api.publicarPosition({ data_ref: lida.data_ref, resumo: lida.resumo, detalhes: lida.detalhes, nome_arquivo: file.name, alerta: textoAlertaFixacao(lida.detalhes, fmtN) });
      toast(`Position of ${fmtData(lida.data_ref)} published.`);
      lida.avisos.forEach((a) => toast(a, "erro"));
      // fórmulas e futuros desta planilha passam a valer para a atualização pelo Digisul
      if (lida.modelo) {
        try {
          await ctx.api.salvarPositionModelo(lida.modelo, file.name);
          ctx.api.sincronizarPosition().catch(() => { /* o agendamento tenta de novo */ });
        } catch (e) { toast(e.message, "erro"); }
      }
      ctx.recarregar();
    },
  }));
}

// ---------------------------------------------------------------- Overview
async function painelOverview(alvo, carga, ctx) {
  const { termm, variacao, kpis } = carga.resumo;
  let grupo = "arabica";
  // quem publica vê também a outra fonte, para conferir planilha × API
  const [historico, outra, modeloInfo] = await Promise.all([
    ctx.api.positionHistorico().catch(() => []),
    ctx.gerente ? ctx.api.positionUltima(ctx.fonte === "api" ? "planilha" : "api").catch(() => null) : null,
    ctx.gerente ? ctx.api.positionModeloInfo().catch(() => null) : null,
  ]);

  const desenhar = async () => {
    limparGraficos();
    // meses sem nenhum número só ocupam espaço (a planilha mantém o calendário inteiro)
    const b = { ...termm[grupo], meses: termm[grupo].meses.filter((m) => COLS_TERMM.some((k) => m[k])) };
    const varG = variacao?.[grupo];
    const anterior = varG?.itens.find((i) => /^previous/i.test(i.rotulo));
    const movimentos = varG?.itens.filter((i) => !/^previous/i.test(i.rotulo) && (i.diff || i.outright)) ?? [];
    // posição atual (TermM) menos a esperada pela Variation: ajustes físicos do dia
    const difDiff = varG ? arred(kpis[grupo].diff - varG.total.diff) : 0;
    const difOut = varG ? arred(kpis[grupo].outright - varG.total.outright) : 0;
    const hist = historico.filter((h) => h.kpis?.[grupo]);

    alvo.innerHTML = `
    <div class="pos-kpis">${Object.keys(NOME_GRUPO).map((k) => {
      const v = variacao?.[k], prev = v?.itens.find((i) => /^previous/i.test(i.rotulo));
      const delta = prev ? kpis[k].outright - prev.outright : null;
      return `<button type="button" class="pos-kpi ${k === grupo ? "on" : ""}" data-grupo="${k}" aria-pressed="${k === grupo}">
        <span class="pos-kpi-t">${NOME_GRUPO[k]} · net outright</span>
        <span class="pos-kpi-v">${fmtSinal(kpis[k].outright)}</span>
        <span class="pos-kpi-s">Net diff position ${fmtSinal(kpis[k].diff)}</span>
        ${delta != null ? `<span class="pos-kpi-d">${delta === 0 ? "No change" : `${delta > 0 ? "▲" : "▼"} ${fmtSinal(delta)}`} vs previous</span>` : ""}
      </button>`;
    }).join("")}</div>

    <section class="pos-card">
      <div class="pos-card-h"><h2>Net position by term month · ${NOME_GRUPO[grupo]}</h2>
        <p class="muted">Bars: physical position (purchases and inventory above zero, sales below). Line: net diff position.</p></div>
      ${b.meses.length ? `<div class="pos-grafico"><canvas id="gMes" role="img" aria-label="Net position by term month, ${NOME_GRUPO[grupo]}"></canvas></div>`
        : `<p class="muted pos-nota">The spreadsheet has no term-month breakdown for ${NOME_GRUPO[grupo]} — only the total below. The month-by-month view is in Physical Position.</p>`}
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead>
          <tr><th rowspan="2">Term month</th><th rowspan="2">Cash</th><th colspan="3">Purchases</th><th rowspan="2">Inventory</th>
            <th rowspan="2">Sales</th><th colspan="3">Exp sales</th><th colspan="3">Int sales</th><th colspan="2">Futures</th>
            <th rowspan="2">Switch exp.</th><th rowspan="2">Net diff position</th><th rowspan="2">Net outright</th></tr>
          <tr><th>Total</th><th>Fixed</th><th>PTBF</th><th>Total</th><th>Fixed</th><th>PTBF</th><th>Total</th><th>Fixed</th><th>PTBF</th><th>Total</th><th>PTBF</th></tr>
        </thead>
        <tbody>${b.meses.map((m) => linhaTermM(fmtMes(m.mes), m)).join("")}</tbody>
        <tfoot>${linhaTermM("Total", b.total, true)}</tfoot>
      </table></div>
    </section>

    <div class="pos-duas">
      <section class="pos-card">
        <div class="pos-card-h"><h2>Change vs previous position · ${NOME_GRUPO[grupo]}</h2></div>
        ${varG ? `<table class="tabela tabela-num">
          <thead><tr><th></th><th>Net diff position</th><th>Net outright</th></tr></thead>
          <tbody>
            ${anterior ? `<tr><td>Previous</td>${celNum(anterior.diff)}${celNum(anterior.outright)}</tr>` : ""}
            ${movimentos.length ? movimentos.map((i) => `<tr><td>${esc(i.rotulo)}</td>${celNum(i.diff)}${celNum(i.outright)}</tr>`).join("")
              : `<tr><td colspan="3" class="muted">No new trades or fixations in this position.</td></tr>`}
          </tbody>
          <tfoot>
            <tr><td>Expected (previous + changes)</td>${celNum(varG.total.diff)}${celNum(varG.total.outright)}</tr>
            <tr><td>Current position</td>${celNum(kpis[grupo].diff, { forte: true })}${celNum(kpis[grupo].outright, { forte: true })}</tr>
            ${difDiff || difOut ? `<tr><td>Difference</td>${celNum(difDiff)}${celNum(difOut)}</tr>` : ""}
          </tfoot>
        </table>
        ${difDiff || difOut ? `<p class="muted pos-nota">A difference usually comes from physical adjustments — e.g. a contract of 3,667 bags that shipped 3,600.</p>` : ""}`
        : `<p class="muted">The Variation sheet has no block for this group.</p>`}
      </section>
      <section class="pos-card">
        <div class="pos-card-h"><h2>Net outright over time · ${NOME_GRUPO[grupo]}</h2></div>
        ${hist.length >= 2 ? `<div class="pos-grafico pos-grafico-sm"><canvas id="gHist" role="img" aria-label="Net outright over time"></canvas></div>`
          : `<p class="muted">The history builds up with each daily upload — this chart appears from the second Position onwards.</p>`}
      </section>
    </div>
    ${ctx.gerente ? cardComparacao(grupo, carga, outra, modeloInfo, ctx) : ""}`;

    $$("[data-grupo]", alvo).forEach((el) => el.addEventListener("click", () => { grupo = el.dataset.grupo; desenhar(); }));
    $("#posOficial", alvo)?.addEventListener("click", () => trocarFonteOficial(ctx));
    if (b.meses.length) {
      await graficoBarrasLinha($("#gMes", alvo), {
        meses: b.meses.map((m) => m.mes),
        series: [
          { rotulo: "Purchases", dados: b.meses.map((m) => m.purchases) },
          { rotulo: "Inventory", dados: b.meses.map((m) => m.inventory) },
          { rotulo: "Sales", dados: b.meses.map((m) => m.sales) },
        ],
        linha: { rotulo: "Net diff position", dados: b.meses.map((m) => m.net_diff) },
      });
    }
    if (hist.length >= 2) {
      await graficoLinha($("#gHist", alvo), { rotulos: hist.map((h) => fmtData(h.data_ref)), dados: hist.map((h) => h.kpis[grupo].outright), rotulo: "Net outright" });
    }
  };
  await desenhar();
}

// Planilha × API lado a lado (fase em paralelo, antes de desligar o upload diário)
const LINHAS_COMPARACAO = [["purchases", "Purchases"], ["inventory", "Inventory"], ["exp_sales", "Exp sales"], ["int_sales", "Int sales"],
  ["futures", "Futures"], ["net_diff", "Net diff position"], ["net_outright", "Net outright"]];

function cardComparacao(grupo, carga, outra, info, ctx) {
  const [pl, ap] = ctx.fonte === "api" ? [outra, carga] : [carga, outra];
  const total = (c, k) => c?.resumo?.termm?.[grupo]?.total?.[k] ?? null;
  const quando = (c) => (c ? `${fmtData(c.data_ref)} · ${tempoRelativo(c.created_at)}` : "—");
  const outraFonte = ctx.oficial === "api" ? "planilha" : "api";
  return `<section class="pos-card">
    <div class="pos-card-h"><h2>Spreadsheet × Digisul API · ${NOME_GRUPO[grupo]}</h2>
      <p class="muted">Check while both sources run in parallel. Differences come from what changed in Digisul between the spreadsheet extraction and the API update.</p></div>
    ${pl && ap ? `<div class="tabela-wrap"><table class="tabela tabela-num">
      <thead><tr><th></th><th>Spreadsheet <span class="muted">${esc(quando(pl))}</span></th><th>Digisul API <span class="muted">${esc(quando(ap))}</span></th><th>Difference</th></tr></thead>
      <tbody>${LINHAS_COMPARACAO.map(([k, rot]) => {
        const a = total(pl, k), b = total(ap, k);
        return `<tr><td>${rot}</td>${celNum(a)}${celNum(b)}${celNum(a != null && b != null ? arred(b - a) : null)}</tr>`;
      }).join("")}</tbody>
    </table></div>`
      : `<p class="muted">${ap ? "No spreadsheet uploaded yet." : "No Digisul update yet — click “Update now”."}</p>`}
    <p class="muted pos-nota">${info
      ? `Formulas and futures (${fmtN(info.futuros)} trades) from ${esc(info.nome_arquivo ?? "—")}, uploaded ${esc(tempoRelativo(info.atualizado_em))}${info.enviado_por ? ` by ${esc(info.enviado_por)}` : ""}.`
      : "The spreadsheet formulas and futures have not been saved yet — upload the full spreadsheet once."}</p>
    <p class="muted pos-nota">Official source: <strong>${NOME_FONTE[ctx.oficial]}</strong></p>
    ${ctx.admin ? `<div><button type="button" class="btn" id="posOficial">${icon("check")}<span>Make ${NOME_FONTE[outraFonte]} the official source</span></button></div>` : ""}
  </section>`;
}

function trocarFonteOficial(ctx) {
  const nova = ctx.oficial === "api" ? "planilha" : "api";
  modal({
    titulo: "Official Position source",
    botao: `Use ${NOME_FONTE[nova]}`,
    corpo: `<p>Everyone will see the Position from <strong>${NOME_FONTE[nova]}</strong>${nova === "api"
      ? ", updated every 2 hours on business days. Keep uploading the spreadsheet (or just the OpenFutures sheet) when futures change."
      : ". The views will only change when the spreadsheet is uploaded."}</p>`,
    async onSubmit() {
      await ctx.api.definirFontePosition(nova);
      guardarFonteVista(nova);
      toast(`Official source: ${NOME_FONTE[nova]}.`);
      ctx.recarregar();
    },
  });
}

function linhaTermM(rotulo, m, total = false) {
  const tag = total ? "th" : "td";
  return `<tr class="${total ? "total" : ""}"><${tag} scope="row">${esc(rotulo)}</${tag}>${[
    m.cash, m.purchases, m.purchases_fixed, m.purchases_ptbf, m.inventory, m.sales, m.exp_sales, m.exp_fixed, m.exp_ptbf,
    m.int_sales, m.int_fixed, m.int_ptbf, m.futures, m.futures_ptbf, m.switch_exp,
  ].map((v) => celNum(v, { forte: total })).join("")}${celNum(m.net_diff, { forte: true })}${celNum(m.net_outright, { forte: true })}</tr>`;
}

// ---------------------------------------------------------------- Physical
// Matriz "posição líquida acumulada por padrão" no layout do Power BI: grupos de
// qualidade recolhíveis (FC, GC, Grinders, LG), totais por grupo e a segmentação
// dos componentes (vendas internas, vendas de exportação, estoque, compras).
const COMPS_FISICA = [["domestic_sales", "Domestic sales"], ["exp_sales", "Export sales"], ["inventory", "Inventory"], ["purchases", "Purchases"]];
const SINAL_COMP = { inventory: "+", purchases: "+", exp_sales: "–", domestic_sales: "–" };
const NOME_COMP = { inventory: "Inventory", purchases: "Purchases", exp_sales: "Export Sales", domestic_sales: "Domestic Sales" };
const MESES_LONGOS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString(LOCALE, { month: "long" }).toUpperCase());
const mesLongo = (iso) => `${MESES_LONGOS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`;
// número como no Power BI: negativo entre parênteses, zero vazio
const numPbi = (v) => (Math.abs(v) < 0.5 ? "" : v < 0 ? `(${fmtN(-v)})` : fmtN(v));

// grupos a partir do cabeçalho da planilha: qualidades seguidas do nome do grupo (… BC3, FC, BC4 …)
function gruposDaPlanilha(colunas, temQualidade) {
  const grupos = [];
  let atual = [];
  for (const c of colunas) {
    if (norm(c) === "TOTAL") break;
    if (temQualidade(c)) atual.push(c);
    else { grupos.push({ nome: c, qualidades: atual }); atual = []; }
  }
  if (atual.length) grupos.push({ nome: "Other", qualidades: atual });
  return grupos;
}

function matrizPorPadrao(f, estado) {
  const conilon = estado.especie === "conilon";
  // Arábica: componentes da planilha (ou a matriz pronta, em dados antigos); Conilon: calculado das abas base
  const comp = conilon ? f.conilon : f.componentes;
  const q = conilon ? null : f.qualidades;
  const temConilon = !!f.conilon;
  const segEspecie = `<div class="pbi-seg pbi-especie" role="group" aria-label="Species">${[["arabica", "ARÁBICA"], ["conilon", "CONILON"]].map(([k, rot]) =>
    `<button type="button" data-especie="${k}" class="${estado.especie === k ? "on" : ""}" aria-pressed="${estado.especie === k}" ${k === "conilon" && !temConilon ? "disabled" : ""}>${esc(rot)}</button>`).join("")}</div>`;
  if (!comp && !q) {
    return `<section class="pos-card pbi-fisica"><div class="pbi-topo">${segEspecie}</div>
      <p class="muted pos-nota">${icon("info")} ${conilon ? "Upload the Position again to see Conilon by standard." : "No data by standard in this Position."}</p></section>`;
  }
  // componentes ligados (nenhum = todos, como no Power BI)
  const ligados = estado.comps.size ? COMPS_FISICA.map(([k]) => k).filter((k) => estado.comps.has(k)) : COMPS_FISICA.map(([k]) => k);
  const meses = comp ? comp.meses : q.com.map((l) => l.mes);
  // acumulado mês a mês de cada qualidade
  const acumulado = {};
  if (comp) {
    for (const [nome, v] of Object.entries(comp.q)) {
      let s = 0;
      acumulado[nome] = meses.map((_, i) => (s += ligados.reduce((t, k) => t + (v[k][i] ?? 0), 0)));
    }
  } else {
    // dados antigos: só a matriz pronta da planilha (todos os componentes)
    q.colunas.forEach((c, j) => { acumulado[c] = q.com.map((l) => l.v[j]); });
  }
  // colunas: as da planilha (Arábica) ou os padrões do Conilon num grupo só
  const colunas = q?.colunas ?? [...Object.keys(acumulado).sort((a, b) => a.localeCompare(b, "en", { numeric: true })), "CONILON", "TOTAL"];
  const temQualidade = (c) => c in acumulado && (!comp || c in comp.q);
  const grupos = gruposDaPlanilha(colunas, temQualidade)
    .map((g) => ({ ...g, qualidades: g.qualidades.filter((c) => acumulado[c].some((v) => Math.abs(v) >= 0.5)) }))
    .filter((g) => g.qualidades.length);
  const totGrupo = (g, i) => g.qualidades.reduce((s, c) => s + acumulado[c][i], 0);
  // período escolhido (os meses anteriores continuam no acumulado); padrão: do mês da posição até o fim
  const ym = meses.map((m) => m.slice(0, 7));
  let de = estado.de && ym.includes(estado.de) ? estado.de : ym.find((m) => m >= estado.mesRef) ?? ym[0];
  let ate = estado.ate && ym.includes(estado.ate) ? estado.ate : ym.at(-1);
  if (de > ate) [de, ate] = [ate, de];
  const opcoesMes = (sel) => ym.map((m) => `<option value="${m}" ${m === sel ? "selected" : ""}>${esc(mesLongo(`${m}-01`))}</option>`).join("");
  const classe = (v) => (Math.abs(v) < 0.5 ? "nil" : v > 0 ? "long" : "short");
  const formula = Object.keys(NOME_COMP).filter((k) => ligados.includes(k)).map((k, i) => `${i === 0 && SINAL_COMP[k] === "+" ? "" : ` ${SINAL_COMP[k]} `}${tr(NOME_COMP[k])}`).join("").trim();

  return `<section class="pos-card pbi-fisica">
    <div class="pbi-topo">
      <div class="pbi-titulo"><strong>${esc(tr("ACCUMULATED NET POSITION BY STANDARD – 60 KG BAGS"))}</strong> <span>${esc(formula)}</span></div>
      <div class="pbi-seg" role="group" aria-label="Components">${COMPS_FISICA.map(([k, rot]) =>
        `<button type="button" data-comp="${k}" class="${estado.comps.has(k) ? "on" : ""}" aria-pressed="${estado.comps.has(k)}" ${comp ? "" : "disabled"}>${esc(tr(rot).toUpperCase())}</button>`).join("")}</div>
      <div class="pbi-legenda"><span><i class="long"></i>LONG</span><span><i class="short"></i>SHORT</span><span><i class="nil"></i>NIL</span></div>
    </div>
    <div class="pbi-topo pbi-topo-2">
      ${segEspecie}
      <label class="pos-mes"><span>From</span><select id="pbiDe" aria-label="From month">${opcoesMes(de)}</select></label>
      <label class="pos-mes"><span>To</span><select id="pbiAte" aria-label="To month">${opcoesMes(ate)}</select></label>
      <span class="pbi-maismenos">
        <button type="button" class="btn btn-ghost" data-meses="-1" ${de === ate ? "disabled" : ""}>− 1 month</button>
        <button type="button" class="btn btn-ghost" data-meses="1" ${ate === ym.at(-1) ? "disabled" : ""}>+ 1 month</button>
      </span>
    </div>
    ${comp ? "" : `<p class="muted pos-nota">${icon("info")} Upload the Position again to choose the components — this data was saved before they were read separately.</p>`}
    ${conilon ? `<p class="muted pos-nota">${icon("info")} Conilon is calculated by the portal from the base sheets (the spreadsheet only builds this matrix for Arabica): purchase breakage goes to BC16, inventory in 60 kg bags, sales by EOM Ship.</p>` : ""}
    <div class="tabela-wrap pbi-wrap"><table class="pbi-matriz">
      <thead>
        <tr><th class="pbi-canto">${esc(conilon ? "CONILON" : tr("ARÁBICA"))}</th>${grupos.map((g) => {
          const fechado = estado.recolhidos.has(g.nome);
          return `<th class="pbi-grupo" colspan="${fechado ? 1 : g.qualidades.length + 1}"><button type="button" data-grupo="${esc(g.nome)}" aria-expanded="${!fechado}" title="${fechado ? "Expand" : "Collapse"}">${fechado ? "⊞" : "⊟"}</button> ${esc(g.nome)}</th>`;
        }).join("")}<th class="pbi-total" rowspan="2">Total</th></tr>
        <tr><th class="pbi-canto">${esc(tr("MONTH"))}</th>${grupos.map((g) => (estado.recolhidos.has(g.nome) ? `<th class="pbi-tot">Total</th>`
          : `${g.qualidades.map((c) => `<th>${esc(c)}</th>`).join("")}<th class="pbi-tot">Total</th>`)).join("")}</tr>
      </thead>
      <tbody>${meses.map((m, i) => {
        if (ym[i] < de || ym[i] > ate) return "";
        let geral = 0;
        const cels = grupos.map((g) => {
          const t = totGrupo(g, i);
          geral += t;
          const qs = estado.recolhidos.has(g.nome) ? "" : g.qualidades.map((c) => { const v = acumulado[c][i]; return `<td class="${v < -0.5 ? "neg" : ""}">${numPbi(v)}</td>`; }).join("");
          return `${qs}<td class="pbi-tot ${classe(t)}">${numPbi(t)}</td>`;
        }).join("");
        return `<tr><th scope="row">${esc(mesLongo(m))}</th>${cels}<td class="pbi-total ${classe(geral)}">${numPbi(geral)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>
  </section>`;
}

async function painelFisica(alvo, carga) {
  const f = carga.resumo.fisica;
  const grupos = ["exportable", "lowgrade"].filter((k) => f[k]);
  let grupo = grupos[0];
  // segmentação começa com os quatro componentes ligados; período do mês da posição até o fim
  const estado = {
    comps: new Set(COMPS_FISICA.map(([k]) => k)), recolhidos: new Set(), especie: "arabica",
    mesRef: String(carga.data_ref ?? "").slice(0, 7), de: null, ate: null,
  };
  const mesesMatriz = () => (estado.especie === "conilon" ? f.conilon?.meses : f.componentes?.meses ?? f.qualidades?.com.map((l) => l.mes)) ?? [];

  const desenhar = () => {
    const b = f[grupo];
    alvo.innerHTML = `
    ${matrizPorPadrao(f, estado)}
    <div class="pos-filtros">${segmentos("segGrupo", grupos.map((k) => [k, NOME_GRUPO[k]]), grupo)}</div>
    <section class="pos-card">
      <div class="pos-card-h"><h2>Physical position by month · ${NOME_GRUPO[grupo]}</h2>
        <p class="muted">Inventory, purchases and sales (export + domestic) of each month, and the running net physical position.</p></div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead><tr><th>Month</th><th>Inventory</th><th>Purchases</th><th>Exp sales</th><th>Domestic sales</th><th>Net (running)</th></tr></thead>
        <tbody>${b.meses.map((m) => `<tr><td>${fmtMes(m.mes)}</td>${celNum(m.inventory)}${celNum(m.purchases)}${celNum(m.exp_sales)}${celNum(m.domestic_sales)}${celNum(m.net, { forte: true })}</tr>`).join("")}</tbody>
        ${b.total ? `<tfoot><tr class="total"><th scope="row">Total</th>${celNum(b.total.inventory, { forte: true })}${celNum(b.total.purchases, { forte: true })}${celNum(b.total.exp_sales, { forte: true })}${celNum(b.total.domestic_sales, { forte: true })}${celNum(b.total.net, { forte: true })}</tr></tfoot>` : ""}
      </table></div>
    </section>`;

    ligarSegmentos(alvo, "segGrupo", (k) => { grupo = k; desenhar(); });
    $$("[data-comp]", alvo).forEach((b2) => b2.addEventListener("click", () => {
      const k = b2.dataset.comp;
      if (estado.comps.has(k)) estado.comps.delete(k); else estado.comps.add(k);
      desenhar();
    }));
    $$("[data-grupo]", alvo).forEach((b2) => b2.addEventListener("click", () => {
      const g = b2.dataset.grupo;
      if (estado.recolhidos.has(g)) estado.recolhidos.delete(g); else estado.recolhidos.add(g);
      desenhar();
    }));
    $$("[data-especie]", alvo).forEach((b2) => b2.addEventListener("click", () => {
      if (estado.especie === b2.dataset.especie) return;
      estado.especie = b2.dataset.especie;
      estado.recolhidos.clear();
      desenhar();
    }));
    $("#pbiDe", alvo)?.addEventListener("change", (e) => { estado.de = e.target.value; desenhar(); });
    $("#pbiAte", alvo)?.addEventListener("change", (e) => { estado.ate = e.target.value; desenhar(); });
    // − / + 1 mês: mexe no fim do período
    $$("[data-meses]", alvo).forEach((b2) => b2.addEventListener("click", () => {
      const ym = mesesMatriz().map((m) => m.slice(0, 7));
      const atual = $("#pbiAte", alvo)?.value ?? ym.at(-1);
      const i = ym.indexOf(atual) + Number(b2.dataset.meses);
      estado.de = $("#pbiDe", alvo)?.value ?? estado.de;
      estado.ate = ym[Math.max(ym.indexOf(estado.de), Math.min(ym.length - 1, i))];
      desenhar();
    }));
  };
  desenhar();
}


// ---------------------------------------------------------------- Contracts
// lotes: inteiro quando a fração é desprezível (somas como 2611.97 viram 2,612)
const contratos = (n) => `${fmtN(n)} ${n === 1 ? "contract" : "contracts"}`;
// Diferencial das vendas de exportação: no sistema o do Conilon vem multiplicado
// por 100 (mesma correção do Power BI, "Diferencial Tratado")
const difExportacao = (r) => (r.diferencial != null && norm(r.especie) === "CONILON" ? r.diferencial / 100 : r.diferencial);
// O preço final (Vlr. Final) do Conilon vem igualmente ×100 — conferido contra o "Valor Contrato (US$)"
const precoExportacao = (r) => (r.vlr_final != null && norm(r.especie) === "CONILON" ? r.vlr_final / 100 : r.vlr_final);

const fmtLotes = (v) => (v == null ? "—" : Math.abs(v - Math.round(v)) < 0.05 ? fmtN(Math.round(v)) : fmtN(v, 1));

// quem fixa, do ponto de vista da Brascof
const QUEM_FIXA = {
  purchases: { COMPRADOR: "Brascof", VENDEDOR: "Supplier" },
  expsales: { EXPORTADOR: "Brascof", IMPORTADOR: "Importer" },
  intsales: { VENDEDOR: "Brascof", COMPRADOR: "Client" },
};

const COLS_FIX = [["fixador", "Fixed by", "quem"], ["lotes", "Lots", "l"], ["lotes_fixados", "Lots fixed", "l"],
  ["lotes_a_fixar", "Lots to fix", "l"], ["_prazo", "Fix by (FND)", "fx"]];

const TABELAS = {
  purchases: {
    titulo: "Purchases", saldo: ["a_entregar", "To deliver"],
    cols: [["contrato", "Contract"], ["fornecedor", "Supplier"], ["padrao", "Quality"], ["especie", "Species"], ["modalidade", "Type"],
      ["sacas", "Bags", "n"], ["a_entregar", "To deliver", "n"], ["prev_entrega", "Delivery", "d"], ["bolsa", "Exchange"],
      ["mes_bolsa", "Month", "m"], ["diferencial", "Diff", "n2"], ...COLS_FIX,
      ["preco", "Price R$/bag", "n2"], ["a_pagar", "To pay R$", "n"], ["certificador", "Certificate"]],
  },
  expsales: {
    titulo: "Export sales", saldo: ["saldo", "To ship"],
    cols: [["contrato", "Contract"], ["importador", "Importer"], ["padrao", "Quality"], ["especie", "Species"], ["sacas", "Bags", "n"],
      ["saldo", "To ship", "n"], ["prev_carga", "Est. loading", "d"], ["embarque", "Shipment", "m"], ["bolsa", "Exchange"],
      ["fixar_mes", "Month", "m"], ["diferencial", "Diff", "n2"], ...COLS_FIX,
      ["vlr_final", "Final price", "n2"], ["unidade", "Unit"], ["incoterm", "Incoterm"], ["certificacao", "Certificate"]],
  },
  intsales: {
    titulo: "Domestic sales", saldo: ["a_entregar", "To deliver"],
    cols: [["contrato", "Contract"], ["cliente", "Client"], ["padrao", "Quality"], ["especie", "Species"], ["modalidade", "Type"],
      ["sacas", "Bags", "n"], ["a_entregar", "To deliver", "n"], ["prev_embarque", "Est. shipment", "d"], ["bolsa", "Exchange"],
      ["fixar_mes", "Month", "m"], ...COLS_FIX, ["preco", "Price R$/bag", "n2"], ["a_receber", "To receive R$", "n"]],
  },
  inventory: {
    titulo: "Inventory", saldo: ["sacas", "Bags"],
    cols: [["lote", "Lot"], ["padrao", "Quality"], ["especie", "Species"], ["bebida", "Cup"], ["peneiras", "Screen"],
      ["sacas", "Bags", "n"], ["safra", "Crop"], ["armazem", "Warehouse"], ["certificador", "Certificate"],
      ["entrada", "Entry", "d"], ["custo", "Cost R$/bag", "n2"]],
  },
};

const NIVEL_FX = {
  vencido: ["critico", "alert", (d) => `${-d} d overdue`],
  urgente: ["alerta", "alert", (d) => (d === 0 ? "today" : `in ${d} d`)],
  breve: ["neutro", "clock", (d) => `in ${d} d`],
  ok: ["", "", (d) => `in ${d} d`],
};

function celula(r, k, tipo, aba) {
  const v = r[k];
  if (tipo === "fx") {
    const p = r._fx;
    if (!p) return `<td>—</td>`;
    const [cls, ic, rot] = NIVEL_FX[p.nivel];
    return `<td class="nowrap">${esc(fmtData(p.data))} <span class="fx ${cls ? `fx-${cls}` : ""}">${ic ? icon(ic) : ""}${esc(rot(p.dias))}</span></td>`;
  }
  if (tipo === "quem") {
    const quem = QUEM_FIXA[aba]?.[norm(v)];
    return `<td title="${esc(v ?? "")}">${esc(quem ?? v ?? "—")}</td>`;
  }
  const numerico = tipo === "n" || tipo === "n2" || tipo === "l";
  const txt = v == null ? "—" : tipo === "n" ? fmtN(v) : tipo === "n2" ? fmtN(v, 2) : tipo === "l" ? fmtLotes(v)
    : tipo === "d" ? fmtData(v) : tipo === "m" ? fmtMes(v) : v;
  return `<td class="${numerico ? "num" : ""} ${numerico && v < 0 ? "neg" : ""}">${esc(txt)}</td>`;
}

const FILTROS_FIX = [["", "All contracts"], ["afixar", "With lots to fix"], ["alerta", `Overdue or due within ${ALERTA_DIAS} days`],
  ["breve", `Due within ${AVISO_DIAS} days`], ["fixados", "Fully fixed"]];

function passaFiltroFix(r, filtro) {
  const p = r._fx;
  if (!filtro) return true;
  if (filtro === "afixar") return r.lotes_a_fixar > 0;
  if (filtro === "alerta") return p && (p.nivel === "vencido" || p.nivel === "urgente");
  if (filtro === "breve") return p && p.nivel !== "ok";
  if (filtro === "vencido" || filtro === "urgente") return p?.nivel === filtro;
  if (filtro === "fixados") return r.lotes > 0 && !(r.lotes_a_fixar > 0);
  return true;
}

async function painelContratos(alvo, carga, ctx) {
  let detalhes;
  try { detalhes = await ctx.api.positionDetalhe(["purchases", "expsales", "intsales", "inventory"]); }
  catch (e) { alvo.innerHTML = `<div class="vazio">${icon("lock")}<h3>Contracts unavailable</h3><p>${esc(e.message)}</p></div>`; return; }
  // prazo de fixação calculado uma vez por linha (a data de hoje muda o alerta, não o upload)
  for (const tipo of Object.keys(CAMPO_MES)) {
    for (const r of detalhes[tipo] ?? []) { r._fx = prazoFixacao(r, tipo); r._prazo = r._fx?.data ?? null; }
  }
  for (const r of detalhes.expsales ?? []) { r.diferencial = difExportacao(r); r.vlr_final = precoExportacao(r); }
  const temLotes = (detalhes.purchases ?? []).some((r) => "lotes_a_fixar" in r);
  const alertas = alertasFixacao(detalhes);
  // estufado e pendente de saída do estoque: Prev. Carga anterior a hoje e ainda com saldo
  // (vem da sincronização com o Digisul; null = ainda não há)
  const hoje = hojeIso();
  const logistica = await ctx.api.positionDetalheApi?.(["logistica"])
    .then((d) => (d.logistica ? d.logistica.filter((r) => r.prev_carga && r.prev_carga < hoje) : null)).catch(() => null);
  let aba = "purchases", busca = "", especie = "", qualidade = "", mes = "", fix = "", ordem = null;
  const abas = () => [...Object.entries(TABELAS).map(([k, d]) => [k, `${d.titulo} (${(detalhes[k] ?? []).length})`]),
    ...(logistica ? [["logistica", `Stuffed, pending stock exit (${logistica.length})`]] : [])];

  const desenhar = () => {
    if (aba === "logistica") {
      alvo.innerHTML = painelLogistica(logistica, { busca, especie, ordem }, abas());
      ligarSegmentos(alvo, "segAba", (k) => { aba = k; qualidade = ""; busca = ""; mes = ""; fix = ""; ordem = null; desenhar(); });
      const fb = $("#fBusca", alvo);
      fb.addEventListener("input", () => { busca = fb.value; desenhar(); $("#fBusca", alvo).focus(); $("#fBusca", alvo).setSelectionRange(busca.length, busca.length); });
      $("#fEspecie", alvo).addEventListener("change", (e) => { especie = e.target.value; desenhar(); });
      $$("[data-ordem]", alvo).forEach((b) => b.addEventListener("click", () => {
        const k = b.dataset.ordem;
        ordem = ordem?.[0] === k ? (ordem[1] > 0 ? [k, -1] : null) : [k, 1];
        desenhar();
      }));
      return;
    }
    const def = TABELAS[aba];
    const todas = detalhes[aba] ?? [];
    const campoMes = CAMPO_MES[aba];
    const ehFix = !!campoMes && temLotes;
    const qualidades = [...new Set(todas.map((r) => r.padrao).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const meses = campoMes ? [...new Set(todas.map((r) => r[campoMes]?.slice(0, 7)).filter(Boolean))].sort() : [];
    const t = busca.toLowerCase();
    // linhas com os filtros comuns (sem o de fixação): base dos indicadores
    const base = todas.filter((r) => (!especie || norm(r.especie) === especie) && (!qualidade || r.padrao === qualidade)
      && (!mes || r[campoMes]?.slice(0, 7) === mes)
      && (!t || def.cols.some(([k]) => String(r[k] ?? "").toLowerCase().includes(t))));
    let linhas = ehFix ? base.filter((r) => passaFiltroFix(r, fix)) : base;
    if (ordem) {
      const [k, dir] = ordem;
      linhas = [...linhas].sort((a, b) => {
        const x = a[k], y = b[k];
        if (x == null) return 1; if (y == null) return -1;
        return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true })) * dir;
      });
    }
    const soma = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
    const [kSaldo, rotSaldo] = def.saldo;

    // indicadores de fixação (sobre as linhas já filtradas por espécie, qualidade, mês e busca)
    const comLotes = base.filter((r) => r.lotes > 0);
    const aFixar = base.filter((r) => r.lotes_a_fixar > 0);
    const lotesAFixar = soma(aFixar, "lotes_a_fixar"), lotesFixados = soma(comLotes, "lotes_fixados");
    const pct = lotesAFixar + lotesFixados ? Math.round((lotesFixados / (lotesAFixar + lotesFixados)) * 100) : null;
    const nivel = (n) => base.filter((r) => r._fx?.nivel === n);
    const [vencidos, urgentes, breves] = ["vencido", "urgente", "breve"].map(nivel);
    const tile = (chave, titulo, valor, sub, cls = "") => `<button type="button" class="pos-kpi pos-kpi-sm ${cls} ${fix === chave ? "on" : ""}" data-fix="${chave}" aria-pressed="${fix === chave}">
      <span class="pos-kpi-t">${titulo}</span><span class="pos-kpi-v">${valor}</span><span class="pos-kpi-s">${sub}</span></button>`;
    const lotesDe = (rows) => fmtLotes(soma(rows, "lotes_a_fixar"));

    const totalAlerta = alertas.vencido.c + alertas.urgente.c;
    const NOMES = { purchases: "purchases", expsales: "export sales", intsales: "domestic sales" };
    const porTipo = Object.keys(CAMPO_MES).map((k) => [k, (alertas.vencido.tipos[k] ?? 0) + (alertas.urgente.tipos[k] ?? 0)]).filter(([, n]) => n);

    alvo.innerHTML = `
    ${temLotes && totalAlerta ? `<div class="pos-alerta" role="alert">${icon("alert")}
      <div><strong>Fixation alert:</strong>
        ${alertas.vencido.c ? `${alertas.vencido.c} ${alertas.vencido.c === 1 ? "contract" : "contracts"} (${fmtLotes(alertas.vencido.l)} lots) past the first notice day` : ""}
        ${alertas.vencido.c && alertas.urgente.c ? " · " : ""}
        ${alertas.urgente.c ? `${alertas.urgente.c} ${alertas.urgente.c === 1 ? "contract" : "contracts"} (${fmtLotes(alertas.urgente.l)} lots) due within ${ALERTA_DIAS} days` : ""}
        <span class="pos-alerta-links">${porTipo.map(([k, n]) => `<button type="button" class="link" data-ver-alerta="${k}">${n} in ${NOMES[k]}</button>`).join("")}</span>
      </div></div>` : ""}
    <div class="pos-filtros">
      ${segmentos("segAba", abas(), aba)}
      <label class="busca sm">${icon("search")}<input type="search" id="fBusca" placeholder="Search contract, supplier…" value="${esc(busca)}"></label>
      <select id="fEspecie" aria-label="Species"><option value="">All species</option>
        <option value="ARABICA" ${especie === "ARABICA" ? "selected" : ""}>Arabica</option><option value="CONILON" ${especie === "CONILON" ? "selected" : ""}>Conilon</option></select>
      <select id="fQual" aria-label="Quality"><option value="">All qualities</option>${qualidades.map((q) => `<option ${q === qualidade ? "selected" : ""}>${esc(q)}</option>`).join("")}</select>
      ${campoMes ? `<select id="fMes" aria-label="Exchange month"><option value="">All months</option>${meses.map((m) => `<option value="${m}" ${m === mes ? "selected" : ""}>${fmtMes(m + "-01")}</option>`).join("")}</select>` : ""}
      ${ehFix ? `<select id="fFix" aria-label="Fixation">${FILTROS_FIX.map(([k, t2]) => `<option value="${k}" ${k === fix ? "selected" : ""}>${t2}</option>`).join("")}</select>` : ""}
    </div>
    ${ehFix ? `<div class="pos-kpis pos-kpis-fix">
      ${tile("afixar", "To fix", `${fmtLotes(lotesAFixar)} lots`, `${contratos(aFixar.length)} · ${fmtN(soma(aFixar, "a_fixar"))} bags`)}
      ${tile("fixados", "Fixed", `${fmtLotes(lotesFixados)} lots`, pct == null ? "No lots in these contracts" : `${pct}% of the lots fixed`)}
      ${tile("vencido", "Past first notice day", `${contratos(vencidos.length)}`, `${lotesDe(vencidos)} lots to fix`, vencidos.length ? "pos-kpi-critico" : "")}
      ${tile("urgente", `Due within ${ALERTA_DIAS} days`, `${contratos(urgentes.length)}`, `${lotesDe(urgentes)} lots to fix`, urgentes.length ? "pos-kpi-alerta" : "")}
      ${tile("breve", `Due in ${ALERTA_DIAS + 1}–${AVISO_DIAS} days`, `${contratos(breves.length)}`, `${lotesDe(breves)} lots to fix`)}
    </div>
    <p class="muted pos-nota">Fix by = estimated first notice day of the exchange month: NY 7 and London 4 business days before the first business day of the month (holidays not counted). Counts are for the filters above.</p>`
      : campoMes && !temLotes ? `<p class="muted pos-nota">${icon("info")} Upload the Position again to see the fixation indicators and alerts.</p>` : ""}
    <div class="pos-resumo">
      <span><strong>${fmtN(linhas.length)}</strong> ${aba === "inventory" ? "lots" : "contracts"}</span>
      <span><strong>${fmtN(soma(linhas, kSaldo))}</strong> bags ${rotSaldo.toLowerCase()}</span>
      <span class="muted">${aba === "inventory" ? "All lots in stock." : "Open contracts only (to deliver/ship, to fix or to pay/receive)."}</span>
    </div>
    <div class="tabela-wrap pos-tabela pos-contratos"><table class="tabela tabela-num">
      <thead><tr>${def.cols.map(([k, rot, tipo]) => `<th class="${["n", "n2", "l"].includes(tipo) ? "num" : ""}"><button type="button" class="ordenar" data-ordem="${k}">${esc(rot)}${ordem?.[0] === k ? (ordem[1] > 0 ? " ▲" : " ▼") : ""}</button></th>`).join("")}</tr></thead>
      <tbody>${linhas.length ? linhas.map((r) => `<tr class="${r._fx?.nivel === "vencido" || r._fx?.nivel === "urgente" ? "linha-alerta" : ""}">${def.cols.map(([k, , tipo]) => celula(r, k, tipo, aba)).join("")}</tr>`).join("")
        : `<tr><td colspan="${def.cols.length}" class="vazio-td">No contracts match these filters.</td></tr>`}</tbody>
    </table></div>`;

    ligarSegmentos(alvo, "segAba", (k) => { aba = k; qualidade = ""; busca = ""; mes = ""; fix = ""; ordem = null; desenhar(); });
    const fb = $("#fBusca", alvo);
    fb.addEventListener("input", () => { busca = fb.value; desenhar(); $("#fBusca", alvo).focus(); $("#fBusca", alvo).setSelectionRange(busca.length, busca.length); });
    $("#fEspecie", alvo).addEventListener("change", (e) => { especie = e.target.value; desenhar(); });
    $("#fQual", alvo).addEventListener("change", (e) => { qualidade = e.target.value; desenhar(); });
    $("#fMes", alvo)?.addEventListener("change", (e) => { mes = e.target.value; desenhar(); });
    $("#fFix", alvo)?.addEventListener("change", (e) => { fix = e.target.value; desenhar(); });
    $$("[data-fix]", alvo).forEach((b) => b.addEventListener("click", () => { fix = fix === b.dataset.fix ? "" : b.dataset.fix; desenhar(); }));
    $$("[data-ver-alerta]", alvo).forEach((b) => b.addEventListener("click", () => {
      aba = b.dataset.verAlerta; fix = "alerta"; busca = ""; qualidade = ""; mes = ""; ordem = ["_prazo", 1]; desenhar();
    }));
    $$("[data-ordem]", alvo).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.ordem;
      ordem = ordem?.[0] === k ? (ordem[1] > 0 ? [k, -1] : null) : [k, 1];
      desenhar();
    }));
  };
  desenhar();
}

// Estufado e pendente de saída do estoque (regra da área de exportação): Prev. Carga
// anterior a hoje e saldo ainda sem saída no Digisul. ETD anterior a ontem e sem
// data de BL = "BL pending" (o navio já saiu e falta o BL).
const COLS_LOGISTICA = [["contrato", "Contract"], ["importador", "Importer"], ["padrao", "Quality"], ["especie", "Species"],
  ["sacas", "Bags", "n"], ["prev_carga", "Est. loading", "d"], ["_dias", "Days", "n"], ["_status", "Status"], ["cheio", "Full container", "d"],
  ["etd", "ETD", "d"], ["data_bl", "BL date", "d"], ["navio", "Vessel"], ["estufagem", "Stuffing site"], ["terminal", "Terminal"],
  ["containers", "Containers", "n"]];

function painelLogistica(todas, { busca, especie, ordem }, abas) {
  const hoje = hojeIso();
  const d = new Date(hoje + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  const ontem = d.toISOString().slice(0, 10);
  const dias = (iso) => Math.round((new Date(hoje + "T12:00:00Z") - new Date(iso + "T12:00:00Z")) / 864e5);
  const t = busca.toLowerCase();
  let linhas = todas.map((r) => {
    const blPendente = !!r.etd && r.etd < ontem && !r.data_bl;
    return {
      ...r,
      _dias: dias(r.prev_carga),
      _status: blPendente ? "BL pending" : r.cheio && r.cheio <= hoje ? "Full container delivered" : r.nfs ? "Invoice issued" : "—",
      _nivel: blPendente ? "vencido" : "",
    };
  }).filter((r) => (!especie || norm(r.especie) === especie)
    && (!t || COLS_LOGISTICA.some(([k]) => String(r[k] ?? "").toLowerCase().includes(t))));
  const [k, dir] = ordem ?? ["prev_carga", 1];
  linhas.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true })) * dir;
  });
  const soma = (rows) => rows.reduce((s, r) => s + (r.sacas ?? 0), 0);
  const vencidos = linhas.filter((r) => r._nivel === "vencido"), antigos = linhas.filter((r) => r._dias > 7);
  const arabica = linhas.filter((r) => norm(r.especie) === "ARABICA"), conilon = linhas.filter((r) => norm(r.especie) === "CONILON");
  const celulaLog = (r, col, tipo) => {
    const v = r[col];
    if (col === "cheio" && v && r.etd && v > r.etd) {
      return `<td class="num" title="${esc(tr("Full container date is after the ETD"))}">${icon("alert")} ${esc(fmtData(v))}</td>`;
    }
    if (tipo === "n") return `<td class="num">${v == null ? "—" : fmtN(v)}</td>`;
    if (tipo === "d") return `<td class="num">${esc(fmtData(v))}</td>`;
    if (col === "_status") return `<td><span class="pill ${v === "BL pending" ? "pill-critico" : ""}">${esc(v)}</span></td>`;
    return `<td>${esc(v ?? "—")}</td>`;
  };
  const tile = (titulo, valor, sub, cls = "") => `<div class="pos-kpi pos-kpi-sm pos-kpi-est ${cls}">
    <span class="pos-kpi-t">${titulo}</span><span class="pos-kpi-v">${valor}</span><span class="pos-kpi-s">${sub}</span></div>`;
  return `
    <div class="pos-filtros">
      ${segmentos("segAba", abas, "logistica")}
      <label class="busca sm">${icon("search")}<input type="search" id="fBusca" placeholder="Search contract, vessel…" value="${esc(busca)}"></label>
      <select id="fEspecie" aria-label="Species"><option value="">All species</option>
        <option value="ARABICA" ${especie === "ARABICA" ? "selected" : ""}>Arabica</option><option value="CONILON" ${especie === "CONILON" ? "selected" : ""}>Conilon</option></select>
    </div>
    <div class="pos-kpis pos-kpis-fix">
      ${tile("Pending stock exit", `${fmtN(soma(linhas))} bags`, contratos(linhas.length))}
      ${tile("Loaded over 7 days ago", `${fmtN(soma(antigos))} bags`, contratos(antigos.length), antigos.length ? "pos-kpi-alerta" : "")}
      ${tile("BL pending (ETD before yesterday)", `${fmtN(soma(vencidos))} bags`, contratos(vencidos.length), vencidos.length ? "pos-kpi-critico" : "")}
      ${tile("Arabica · Conilon", `${fmtN(soma(arabica))} · ${fmtN(soma(conilon))}`, "bags")}
    </div>
    <p class="muted pos-nota">${icon("info")} <span>Export contracts with an estimated loading date before today and bags still without exit from stock in Digisul. From the Digisul API, updated every 2 hours.</span></p>
    <div class="tabela-wrap pos-tabela pos-contratos"><table class="tabela tabela-num">
      <thead><tr>${COLS_LOGISTICA.map(([c, rot, tipo]) => `<th class="${["n", "d"].includes(tipo) ? "num" : ""}"><button type="button" class="ordenar" data-ordem="${c}">${esc(rot)}${k === c && ordem ? (dir > 0 ? " ▲" : " ▼") : ""}</button></th>`).join("")}</tr></thead>
      <tbody>${linhas.length ? linhas.map((r) => `<tr class="${r._nivel === "vencido" ? "linha-alerta" : ""}">${COLS_LOGISTICA.map(([c, , tipo]) => celulaLog(r, c, tipo)).join("")}</tr>`).join("")
        : `<tr><td colspan="${COLS_LOGISTICA.length}" class="vazio-td">No contracts match these filters.</td></tr>`}</tbody>
    </table></div>`;
}

// =====================================================================
// CROP OVER CROP: Export Sales e Purchases
// Venda realizada = mês do BL; safra = coluna Safras do contrato.
// Compra = mês da emissão do contrato; safra = coluna Safra.
// Ano-safra de julho a junho; o que cai fora vira "Earlier" / "Later".
// =====================================================================
const LB_SACA = 60 * 2.20462262;            // libras por saca de 60 kg
const USDT_PARA_CLB = 100 / 2204.62262;     // US$/t → ¢/lb
const MES_INICIO_SAFRA = 7;
const MESES_SAFRA = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];

const inicioSafra = (s) => { const m = String(s ?? "").match(/^(\d{4})/); return m ? Number(m[1]) : null; };
const safraAnterior = (s) => { const i = inicioSafra(s); return i == null ? null : `${i - 1}/${i}`; };
// posição do mês dentro da safra: 0 = julho do 1º ano … 11 = junho; -1 antes, 12 depois
function posicaoSafra(iso, safra) {
  const ini = inicioSafra(safra);
  if (!iso || ini == null) return null;
  const [y, m] = iso.split("-").map(Number);
  return Math.max(-1, Math.min(12, (y - ini) * 12 + (m - MES_INICIO_SAFRA)));
}
const SEM_DATA = 99; // saldo a embarcar sem previsão de carga
const rotuloPosicao = (k) => tr(k === SEM_DATA ? "No date" : k < 0 ? "Earlier" : k > 11 ? "Later" : MESES_SAFRA[k]);

// ---------------------------------------------------------------- cliente final (mesma regra do Power BI)
function clienteFinal(r) {
  const a = String(r.alertas ?? "").trim();
  if (a) return a;
  const ref = String(r.referencia ?? "").trim().toUpperCase();
  if (ref.startsWith("PH")) return "HACOFCO";
  if (ref.startsWith("P0") || ref.startsWith("P6")) return "AMCOF";
  return null;
}
const REGRAS_CLIENTE = [
  [(c) => c === "JJ" || c.includes("JJ TYPE"), "KRAFT / JJ"],
  [["LAVAZZA"], "LAVAZZA"], [["JDE"], "JDE"], [["DUNKIN"], "DUNKIN DONUTS"], [["GESTION CARGO", "COLCAFE"], "COLCAFE"],
  [["GIMOKA"], "GIMOKA"], [["KRAFT"], "KRAFT / JJ"], [["DARBOVEN"], "DARBOVEN"], [["MEHMET", "EFENDI"], "MEHMET EFENDI"],
  [["ILLY"], "ILLY"], [["NESTLE", "ZOEGAS"], "NESTLE"], [["ALLEGRO"], "ALLEGRO"], [["MELITTA"], "MELITTA"], [["WESTROCK"], "WESTROCK"],
  [["LUCKIN"], "LUCKIN CHINA"], [["K-FEE", "K FEE", "KFEE"], "K-FEE"], [["CAFINCO"], "CAFINCO"], [["CAFIVER"], "CAFIVER"],
  [["CAFE SATI"], "CAFE SATI"], [["CAFE TOSTADO"], "CAFE TOSTADO DE EXPORTACION"], [["PAULIG"], "PAULIG"], [["CARUSO"], "CARUSO"],
  [["DALLMAY"], "DALLMAY"], [["COFHOLD"], "COFHOLD"], [["COFFEIN", "COFFEEIN"], "COFFEIN"], [["CCC"], "CCC"],
  [["MOTHER PARKER", "MPARKER", "MPUSA", "EIGHT O"], "MOTHER PARKERS"], [["GAVINA"], "GAVINA"], [["SWISS WATER"], "SWISS WATER"],
  [["S&D"], "S&D"], [["STARBUCKS"], "STARBUCKS"], [["VOLCAFE"], "VOLCAFE"], [["MITSUI"], "MITSUI"], [["BLASER TRADING"], "BLASER TRADING"],
  [["WAKEFIELD"], "WAKEFIELD"], [["BENNET"], "BENNETTS"], [["RUCQUOY"], "RUCQUOY"], [["FALCON COFFEES"], "FALCON COFFEES"],
  [["SUCAFINA"], "SUCAFINA"], [["WALTER MATTER"], "WALTER MATTER"], [["ICT"], "ICT"], [["AMCOF"], "AMCOF"], [["HACOFCO"], "HACOFCO"],
];
const SEM_CLIENTE = "(no client)";
function clientePadronizado(r) {
  const bruto = clienteFinal(r);
  if (!bruto) return SEM_CLIENTE;
  const c = bruto.toUpperCase();
  for (const [teste, nome] of REGRAS_CLIENTE) {
    if (typeof teste === "function" ? teste(c) : teste.some((t) => c.includes(t))) return nome;
  }
  return bruto;
}

// ---------------------------------------------------------------- agregação
const novoAcumulado = () => ({ sacas: 0, valor: 0, brl: 0, brlUsd: 0, difPeso: 0, difSacas: 0, precoPeso: 0, precoSacas: 0, n: 0 });
function agregar(linhas, chave) {
  const m = new Map();
  for (const r of linhas) {
    const k = chave(r);
    const a = m.get(k) ?? novoAcumulado();
    a.sacas += r._sacas; a.valor += r._valor; a.n++;
    if (r._brl != null) { a.brl += r._brl; a.brlUsd += r._valor; }
    if (r._dif != null) { a.difPeso += r._dif * r._sacas; a.difSacas += r._sacas; }
    if (r._preco != null) { a.precoPeso += r._preco * r._sacas; a.precoSacas += r._sacas; }
    m.set(k, a);
  }
  return m;
}
const VAZIO = novoAcumulado();
const total = (linhas) => agregar(linhas, () => 0).get(0) ?? VAZIO;
const media = (a, campo) => (a?.[campo + "Sacas"] ? a[campo + "Peso"] / a[campo + "Sacas"] : null);
// PTAX média ponderada pelo valor em US$
const ptaxMedia = (a) => (a?.brlUsd ? a.brl / a.brlUsd : null);

const fmtDin = (v, moeda = "$") => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  return a >= 1e6 ? `${s}${moeda}${fmtN(a / 1e6, 2)}M` : a >= 1e3 ? `${s}${moeda}${fmtN(a / 1e3, 1)}K` : `${s}${moeda}${fmtN(a)}`;
};
// variação contra o ano anterior: % para volumes e valores, diferença absoluta para preços/diferenciais
function yoy(atual, ant, { abs = false, dec = 2 } = {}) {
  if (atual == null || ant == null || (!abs && !ant)) return `<span class="muted">—</span>`;
  const d = atual - ant;
  if (Math.abs(d) < 1e-9) return `<span class="yoy">= 0</span>`;
  const seta = d > 0 ? "▲" : "▼";
  const txt = abs ? `${d > 0 ? "+" : ""}${fmtN(d, dec)}` : `${d > 0 ? "+" : ""}${fmtN((d / Math.abs(ant)) * 100)}%`;
  return `<span class="yoy">${seta} ${txt}</span>`;
}
const barra = (v, max) => `<span class="cel-barra"><i style="width:${max ? Math.max(0, Math.min(100, (v / max) * 100)) : 0}%"></i><b>${fmtN(v)}</b></span>`;
const fmtSinalDec = (v) => (v > 0 ? "+" : "") + fmtN(v, 2);
const pct = (v, base) => (base ? `${fmtN((v / base) * 100, 1)}%` : "—");

// barras agrupadas: safra escolhida (série 1) × safra anterior (cinza), um eixo em sacas
async function graficoSafras(canvas, { rotulos, atual, anterior, rotAtual, rotAnterior }) {
  const Chart = await carregarChart();
  const t = tema();
  const c = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: [
        { label: rotAtual, data: atual, backgroundColor: t.s1, borderRadius: 3, maxBarThickness: 26 },
        ...(anterior ? [{ label: rotAnterior, data: anterior, backgroundColor: t.muda, borderRadius: 3, maxBarThickness: 26 }] : []),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 }, callback: (v) => fmtK(v) },
          title: { display: true, text: tr("bags (60 kg)"), color: t.muda, font: { size: 11 } } },
      },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtN(ctx.raw)} ${tr("bags")}` } },
      },
    },
  });
  graficos.push(c);
}

// Monta a visão comum aos dois cards. `cfg` descreve o que muda entre vendas e compras.
async function painelSafras(alvo, ctx, cfg) {
  let dados;
  try { dados = (await ctx.api.positionDetalhe([cfg.tipo]))[cfg.tipo] ?? []; }
  catch (e) { alvo.innerHTML = `<div class="vazio">${icon("lock")}<h3>${esc(cfg.titulo)} unavailable</h3><p>${esc(e.message)}</p></div>`; return; }
  if (!dados.length) {
    alvo.innerHTML = `<p class="muted pos-nota">${icon("info")} Upload the Position again to build this view (it needs the full contract history).</p>`;
    return;
  }
  dados.forEach(cfg.preparar);
  const safras = [...new Set(dados.map((r) => r.safra).filter((s) => inicioSafra(s) != null))].sort();
  const comMovimento = safras.filter((s) => dados.some((r) => r.safra === s && r._pos != null));
  // abre na safra corrente (a que contém hoje), se houver dados dela
  const hoje = hojeIso();
  const corrente = safras.find((s) => { const p = posicaoSafra(hoje, s); return p >= 0 && p <= 11; });
  let safra = comMovimento.includes(corrente) ? corrente : comMovimento.at(-1) ?? safras.at(-1);
  let bolsa = "NY", extra = "", qualidade = "", contrato = "", ranking = cfg.rankings[0][0];
  // aEntregar: só o saldo ainda a embarcar, pela previsão de carga (sem comparação com a safra anterior)
  let aEntregar = false;
  const temSaldo = dados.some((r) => "saldo" in r);

  const desenhar = async () => {
    limparGraficos();
    const temBrl = !!cfg.temBrl && !aEntregar;
    const busca = contrato.trim().toUpperCase();
    const fonte = aEntregar
      ? dados.filter((r) => r.saldo > 0).map((r) => ({ ...r, _sacas: r.saldo, _valor: r._valorE ?? 0, _brl: null, _pos: r._posE }))
      : dados;
    const daBolsa = fonte.filter((r) => r._pos != null && (!bolsa || norm(r.bolsa) === bolsa));
    const base = daBolsa.filter((r) => (!extra || cfg.extra.valor(r) === extra) && (!qualidade || r.padrao === qualidade)
      && (!busca || String(r.contrato ?? "").toUpperCase().includes(busca)));
    const atual = base.filter((r) => r.safra === safra);
    const ant = safraAnterior(safra);
    // safra em andamento (ou futura): compara com o mesmo período da anterior, até o mês de hoje
    const posHoje = posicaoSafra(hoje, safra);
    const emAndamento = posHoje <= 11;
    const limite = emAndamento ? posHoje : 12;
    const anterior = aEntregar ? [] : base.filter((r) => r.safra === ant && r._pos <= limite);
    const semPreco = aEntregar ? atual.filter((r) => r._valorE == null) : [];
    const rotVol = aEntregar ? "To ship" : cfg.rotVolume;
    const rotValor = aEntregar ? "Est. value" : cfg.rotValor;
    const periodo = !emAndamento ? "full crop" : limite >= 0 ? `Jul–${MESES_SAFRA[limite]}, same period` : "same period, before the crop year";
    const tA = total(atual), tP = total(anterior);
    const temDif = !!bolsa;
    const unDif = cfg.unidadeDif(bolsa);
    const dif = (a) => (temDif && media(a, "dif") != null ? fmtSinalDec(media(a, "dif")) : "—");
    const dDif = (a, b) => (temDif ? yoy(media(a, "dif"), media(b, "dif"), { abs: true }) : "—");

    // tabela por mês (posição na safra)
    const mA = agregar(atual, (r) => r._pos), mP = agregar(anterior, (r) => r._pos);
    const posicoes = [...new Set([...mA.keys(), ...mP.keys()])].sort((a, b) => a - b);
    const maxMes = Math.max(1, ...[...mA.values()].map((a) => a.sacas));

    // opções dos filtros (dentro da bolsa escolhida)
    const opcoesExtra = [...new Set(daBolsa.map(cfg.extra.valor).filter(Boolean))].sort();
    const opcoesQual = [...new Set(daBolsa.map((r) => r.padrao).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const semPtax = temBrl ? atual.filter((r) => r._brl == null).length : 0;

    const tileK = (titulo, valor, py, delta) => `<div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">${titulo}</span>
      <span class="pos-kpi-v">${valor}</span>${aEntregar ? "" : `<span class="pos-kpi-s"><span>PY:</span> ${py} ${delta}</span>`}</div>`;
    const rotRk = cfg.rankings.find(([k]) => k === ranking)[1];

    alvo.innerHTML = `
    <div class="pos-filtros">
      <select id="fSafra" aria-label="Crop">${safras.slice().reverse().map((s) => `<option ${s === safra ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      ${segmentos("segBolsa", [["NY", "NY (Arabica)"], ["LONDRES", "London (Robusta)"], ["", "All"]], bolsa)}
      <select id="fExtra" aria-label="${esc(cfg.extra.rotulo)}"><option value="">${esc(cfg.extra.todos)}</option>${opcoesExtra.map((v) => `<option ${v === extra ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <select id="fQual" aria-label="Quality"><option value="">All qualities</option>${opcoesQual.map((v) => `<option ${v === qualidade ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <label class="busca sm">${icon("search")}<input type="search" id="fContrato" placeholder="Search contract…" value="${esc(contrato)}"></label>
      ${cfg.temEntregar ? `<label class="check-linha"><input type="checkbox" id="fEntregar" ${aEntregar ? "checked" : ""}><span>Open balance to ship only</span></label>` : ""}
      <span class="muted pos-nota">${aEntregar ? "Balance still to ship · by estimated loading month" : `Compared with ${esc(ant ?? "—")} · ${periodo}`}</span>
    </div>
    ${aEntregar && !temSaldo ? `<p class="muted pos-nota">${icon("info")} Upload the Position again to see the open balance to ship.</p>` : ""}
    ${aEntregar && semPreco.length ? `<p class="muted pos-nota">${icon("info")} <span>${fmtN(semPreco.length)} contracts (${fmtN(semPreco.reduce((s, r) => s + r._sacas, 0))} bags) still without a final price — pending fixation.</span> <span>Value and average price consider only priced contracts.</span></p>` : ""}
    <div class="pos-kpis">
      ${tileK(`${rotVol} · bags`, fmtN(tA.sacas), fmtN(tP.sacas), yoy(tA.sacas, tP.sacas))}
      ${aEntregar ? tileK("Contracts", fmtN(tA.n), "", "") : ""}
      ${tileK(rotValor, fmtDin(tA.valor, cfg.moeda), fmtDin(tP.valor, cfg.moeda), yoy(tA.valor, tP.valor))}
      ${temBrl ? tileK("Revenue R$ · PTAX D-1", fmtDin(tA.brl, "R$"), fmtDin(tP.brl, "R$"), yoy(tA.brl, tP.brl)) : ""}
      ${tileK(`${cfg.rotPreco}`, media(tA, "preco") == null ? "—" : fmtN(media(tA, "preco"), 2), media(tP, "preco") == null ? "—" : fmtN(media(tP, "preco"), 2), yoy(media(tA, "preco"), media(tP, "preco"), { abs: true }))}
      ${tileK(`${cfg.rotDif} · ${unDif}`, dif(tA), dif(tP), temDif ? dDif(tA, tP) : `<span class="muted">select an exchange</span>`)}
    </div>
    ${temBrl ? `<p class="muted pos-nota">Revenue R$ = revenue US$ × PTAX (buy) of the business day before each BL. Average PTAX: ${ptaxMedia(tA) == null ? "—" : fmtN(ptaxMedia(tA), 4)}.${semPtax ? ` <span>${semPtax} shipments without PTAX — upload the Position again.</span>` : ""}</p>` : ""}

    <section class="pos-card">
      <div class="pos-card-h"><h2>${aEntregar ? `${esc(rotVol)} by month · ${esc(safra)}` : `${esc(rotVol)} by month · ${esc(safra)} vs ${esc(ant ?? "—")}`}</h2>
        <p class="muted">${esc(aEntregar ? "Open balance (Saldo) by estimated loading month (Prev. Carga, or the shipment month when there is no estimate); crop from the contract. Value estimated at the final price." : cfg.notaMes)}</p></div>
      <div class="pos-grafico pos-grafico-sm"><canvas id="gSafra" role="img" aria-label="${esc(rotVol)} by month, this crop and previous crop"></canvas></div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead><tr><th>Month</th><th class="num">Volume</th><th class="num cmp">PY</th><th class="num cmp">YOY</th>
          <th class="num">${esc(rotValor)}</th><th class="num cmp">PY</th><th class="num cmp">YOY</th>
          ${temBrl ? `<th class="num">Revenue R$</th><th class="num">Avg PTAX</th>` : ""}
          <th class="num">${esc(cfg.rotDif)}</th><th class="num cmp">PY</th><th class="num cmp">Δ</th></tr></thead>
        <tbody>${posicoes.map((p) => { const a = mA.get(p) ?? VAZIO, b = mP.get(p); return `<tr><td>${rotuloPosicao(p)}</td>
          <td class="num">${barra(a.sacas, maxMes)}</td><td class="num cmp">${b ? fmtN(b.sacas) : "—"}</td><td class="num cmp">${yoy(a.sacas, b?.sacas)}</td>
          <td class="num">${fmtDin(a.valor, cfg.moeda)}</td><td class="num cmp">${b ? fmtDin(b.valor, cfg.moeda) : "—"}</td><td class="num cmp">${yoy(a.valor, b?.valor)}</td>
          ${temBrl ? `<td class="num">${fmtDin(a.brl, "R$")}</td><td class="num">${ptaxMedia(a) == null ? "—" : fmtN(ptaxMedia(a), 4)}</td>` : ""}
          <td class="num">${dif(a)}</td><td class="num cmp">${b ? dif(b) : "—"}</td><td class="num cmp">${dDif(a, b)}</td></tr>`; }).join("")}</tbody>
        <tfoot><tr class="total"><th scope="row">Total</th><td class="num">${fmtN(tA.sacas)}</td><td class="num cmp">${fmtN(tP.sacas)}</td><td class="num cmp">${yoy(tA.sacas, tP.sacas)}</td>
          <td class="num">${fmtDin(tA.valor, cfg.moeda)}</td><td class="num cmp">${fmtDin(tP.valor, cfg.moeda)}</td><td class="num cmp">${yoy(tA.valor, tP.valor)}</td>
          ${temBrl ? `<td class="num">${fmtDin(tA.brl, "R$")}</td><td class="num">${ptaxMedia(tA) == null ? "—" : fmtN(ptaxMedia(tA), 4)}</td>` : ""}
          <td class="num">${dif(tA)}</td><td class="num cmp">${dif(tP)}</td><td class="num cmp">${dDif(tA, tP)}</td></tr></tfoot>
      </table></div>
    </section>

    <section class="pos-card">
      <div class="pos-card-h pos-card-h-linha"><div><h2>Report by ${esc(rotRk.toLowerCase())} · ${esc(safra)}</h2>
        <p class="muted">${aEntregar ? "Share of the open balance to ship." : `Volume share and change vs ${esc(ant ?? "—")} (${periodo}).`}${cfg.dicaRanking && ranking === cfg.extra.campo ? ` ${esc(cfg.dicaRanking)}` : ""}</p></div>
        ${segmentos("segRk", cfg.rankings.map(([k, t2]) => [k, t2]), ranking)}</div>
      <div class="tabela-wrap pos-tabela">${ranking === "peneira" ? tabelaPeneiras(atual, anterior, tA, dif, dDif, cfg) : tabelaRanking(atual, anterior, tA, dif, dDif, cfg, ranking)}</div>
    </section>`;

    $("#fSafra", alvo).addEventListener("change", (e) => { safra = e.target.value; desenhar(); });
    $("#fExtra", alvo).addEventListener("change", (e) => { extra = e.target.value; desenhar(); });
    $("#fQual", alvo).addEventListener("change", (e) => { qualidade = e.target.value; desenhar(); });
    $("#fEntregar", alvo)?.addEventListener("change", (e) => { aEntregar = e.target.checked; desenhar(); });
    alvo.classList.toggle("pos-sem-comparacao", aEntregar);
    const fc = $("#fContrato", alvo);
    fc.addEventListener("input", () => { contrato = fc.value; desenhar().then(() => { const n = $("#fContrato", alvo); n.focus(); n.setSelectionRange(contrato.length, contrato.length); }); });
    ligarSegmentos(alvo, "segBolsa", (k) => { bolsa = k; extra = ""; qualidade = ""; desenhar(); });
    ligarSegmentos(alvo, "segRk", (k) => { ranking = k; desenhar(); });
    $$("[data-extra]", alvo).forEach((linha) => linha.addEventListener("click", () => { extra = extra === linha.dataset.extra ? "" : linha.dataset.extra; desenhar(); }));
    $$("[data-qual]", alvo).forEach((linha) => linha.addEventListener("click", () => { qualidade = qualidade === linha.dataset.qual ? "" : linha.dataset.qual; desenhar(); }));

    const comDados = posicoes.filter((p) => mA.has(p) || mP.has(p));
    await graficoSafras($("#gSafra", alvo), {
      rotulos: comDados.map(rotuloPosicao),
      atual: comDados.map((p) => arred(mA.get(p)?.sacas ?? 0)),
      anterior: aEntregar ? null : comDados.map((p) => arred(mP.get(p)?.sacas ?? 0)),
      rotAtual: aEntregar ? `${safra} · ${tr("To ship")}` : safra, rotAnterior: `${ant ?? tr("Previous")}${periodo === "full crop" ? "" : ` (${tr(periodo)})`}`,
    });
  };
  await desenhar();
}

// Ranking simples (cliente, qualidade, grupo, fornecedor…)
function tabelaRanking(atual, anterior, tA, dif, dDif, cfg, ranking) {
  const [rk, rot, campo] = cfg.rankings.find(([k]) => k === ranking);
  const rA = agregar(atual, campo), rP = agregar(anterior, campo);
  const itens = [...rA.entries()].sort((a, b) => b[1].sacas - a[1].sacas);
  const max = Math.max(1, ...itens.map(([, a]) => a.sacas));
  const clicavel = (k) => (cfg.extra.campo === rk ? `class="clicavel" data-extra="${esc(k)}"` : rk === "padrao" ? `class="clicavel" data-qual="${esc(k)}"` : "");
  return `<table class="tabela tabela-num">
    <thead><tr><th>${esc(rot)}</th><th class="num">Volume</th><th class="num">%</th><th class="num cmp">YOY</th>
      <th class="num">${esc(cfg.rotValor)}</th><th class="num cmp">YOY</th><th class="num">${esc(cfg.rotDif)}</th><th class="num cmp">Δ PY</th></tr></thead>
    <tbody>${itens.length ? itens.map(([k, a]) => { const b = rP.get(k); return `<tr ${clicavel(k)}><td>${esc(k)}</td>
      <td class="num">${barra(a.sacas, max)}</td><td class="num">${pct(a.sacas, tA.sacas)}</td><td class="num cmp">${yoy(a.sacas, b?.sacas)}</td>
      <td class="num">${fmtDin(a.valor, cfg.moeda)}</td><td class="num cmp">${yoy(a.valor, b?.valor)}</td>
      <td class="num">${dif(a)}</td><td class="num cmp">${dDif(a, b)}</td></tr>`; }).join("")
      : `<tr><td colspan="8" class="vazio-td">No data for these filters.</td></tr>`}</tbody>
  </table>`;
}

// Qualidade e, logo abaixo, as peneiras dela com o % dentro da qualidade
function tabelaPeneiras(atual, anterior, tA, dif, dDif, cfg) {
  // dados gravados antes da coluna Peneira existir no upload
  if (atual.length && !atual.some((r) => "peneira" in r)) {
    return `<p class="muted pos-nota pos-nota-bloco">${icon("info")} Upload the Position again to see the screens — the data on the portal was saved before screens were read from the spreadsheet.</p>`;
  }
  const chaveQ = (r) => r.padrao ?? "—";
  const chaveS = (r) => `${chaveQ(r)}\u0001${r.peneira ?? "—"}`;
  const qA = agregar(atual, chaveQ), qP = agregar(anterior, chaveQ);
  const sA = agregar(atual, chaveS), sP = agregar(anterior, chaveS);
  const quals = [...qA.entries()].sort((a, b) => b[1].sacas - a[1].sacas);
  const max = Math.max(1, ...quals.map(([, a]) => a.sacas));
  const linhas = quals.map(([q, a]) => {
    const b = qP.get(q);
    const telas = [...sA.entries()].filter(([k]) => k.startsWith(`${q}\u0001`)).sort((x, y) => y[1].sacas - x[1].sacas);
    return `<tr class="linha-grupo clicavel" data-qual="${esc(q)}"><td><strong>${esc(q)}</strong></td><td class="num">${barra(a.sacas, max)}</td>
      <td class="num">${pct(a.sacas, tA.sacas)}</td><td class="num">100%</td><td class="num cmp">${yoy(a.sacas, b?.sacas)}</td>
      <td class="num">${fmtDin(a.valor, cfg.moeda)}</td><td class="num">${dif(a)}</td><td class="num cmp">${dDif(a, b)}</td></tr>
      ${telas.map(([k, s]) => { const sp = sP.get(k); return `<tr class="linha-sub"><td>${esc(k.split("\u0001")[1])}</td>
        <td class="num">${fmtN(s.sacas)}</td><td class="num">${pct(s.sacas, tA.sacas)}</td><td class="num"><strong>${pct(s.sacas, a.sacas)}</strong></td>
        <td class="num cmp">${yoy(s.sacas, sp?.sacas)}</td><td class="num">${fmtDin(s.valor, cfg.moeda)}</td><td class="num">${dif(s)}</td><td class="num cmp">${dDif(s, sp)}</td></tr>`; }).join("")}`;
  }).join("");
  return `<table class="tabela tabela-num pos-peneiras">
    <thead><tr><th>Quality / screen</th><th class="num">Volume</th><th class="num">% of total</th><th class="num">% of quality</th><th class="num cmp">YOY</th>
      <th class="num">${esc(cfg.rotValor)}</th><th class="num">${esc(cfg.rotDif)}</th><th class="num cmp">Δ PY</th></tr></thead>
    <tbody>${linhas || `<tr><td colspan="8" class="vazio-td">No data for these filters.</td></tr>`}</tbody>
  </table>`;
}

// Export Sales: volume embarcado, receita (US$ e R$ pela PTAX D-1 de cada BL), preço e diferencial em ¢/lb
function painelVendas(alvo, carga, ctx) {
  return painelSafras(alvo, ctx, {
    tipo: "vendas", titulo: "Export sales", rotVolume: "Shipped", rotValor: "Revenue", moeda: "$", temBrl: true, temEntregar: true,
    rotPreco: "Avg final price · ¢/lb", rotDif: "Sale diff", unidadeDif: () => "¢/lb",
    notaMes: "Realized sales: month of the bill of lading (BL); crop from the contract. Crop year July to June.",
    dicaRanking: "Click a client to filter the page.",
    extra: { campo: "cliente", rotulo: "Client", todos: "All clients", valor: (r) => r._cliente },
    rankings: [["cliente", "Client", (r) => r._cliente], ["padrao", "Quality", (r) => r.padrao ?? "—"],
      ["peneira", "Quality / screen", null], ["grupo", "Quality group", (r) => r.grupo ?? "—"]],
    preparar(r) {
      const porTon = /TON/i.test(r.unidade ?? "");
      r._sacas = r.saida > 0 ? r.saida : (r.sacas ?? 0);
      // contrato pendente de fixação vem com preço final 0: fica sem preço (não entra nas médias)
      const preco = precoExportacao(r) || null;
      r._preco = preco == null ? null : porTon ? preco * USDT_PARA_CLB : preco;
      r._valor = r._preco != null ? (r._preco / 100) * r._sacas * LB_SACA : (r.valor_usd ?? 0);
      r._brl = r.ptax != null ? r._valor * r.ptax : null;
      const dif = difExportacao(r);
      r._dif = dif == null ? null : porTon ? dif * USDT_PARA_CLB : dif;
      r._pos = posicaoSafra(r.data_bl, r.safra);
      r._cliente = clientePadronizado(r);
      // saldo a embarcar: mês da previsão de carga (ou do embarque); sem data → "No date"
      const dataPrev = r.prev_carga ?? r.embarque;
      r._posE = dataPrev ? posicaoSafra(dataPrev, r.safra) : SEM_DATA;
      r._valorE = r.saldo > 0 && r._preco != null ? (r._preco / 100) * r.saldo * LB_SACA : null;
    },
  });
}

// Purchases: volume contratado, valor (R$), preço médio (R$/saca) e diferencial
function painelCompras(alvo, carga, ctx) {
  return painelSafras(alvo, ctx, {
    tipo: "compras", titulo: "Purchases", rotVolume: "Purchased", rotValor: "Value R$", moeda: "R$",
    rotPreco: "Avg price · R$/bag", rotDif: "Purch diff", unidadeDif: (b) => (b === "NY" ? "¢/lb" : b ? "exchange unit" : "select an exchange"),
    notaMes: "Purchases by contract date (issue month); crop from the contract. Crop year July to June.",
    dicaRanking: "Click a supplier to filter the page.",
    extra: { campo: "fornecedor", rotulo: "Supplier", todos: "All suppliers", valor: (r) => r.fornecedor },
    rankings: [["fornecedor", "Supplier", (r) => r.fornecedor ?? "—"], ["padrao", "Quality", (r) => r.padrao ?? "—"], ["modalidade", "Type", (r) => r.modalidade ?? "—"]],
    preparar(r) {
      r._sacas = r.sacas ?? 0;
      r._valor = r.valor ?? 0;
      r._preco = r.preco;
      r._dif = r.diferencial;
      r._pos = posicaoSafra(r.emissao, r.safra);
    },
  });
}

// =====================================================================
// DIFERENCIAIS MÉDIOS DAS EXPORTAÇÕES
// Média do diferencial de venda (ponderada pelas sacas) por mês e por
// qualidade, contando o mês pela Data de Inclusão do contrato ou pelo
// EOM Ship (mês de embarque). Mesmos dados do card Export Sales.
// =====================================================================
const mesIso = (iso) => (iso ? iso.slice(0, 7) : null);           // "2026-10-15" → "2026-10"
const somaMes = (ym, n) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const mesesEntre = (de, ate) => { const out = []; for (let m = de; m <= ate && out.length < 60; m = somaMes(m, 1)) out.push(m); return out; };
const rotMes = (ym) => fmtMes(`${ym}-01`);

// barras = sacas (eixo da direita), linha = diferencial médio (eixo da esquerda)
async function graficoDiffs(canvas, { rotulos, difs, sacas, unidade }) {
  const Chart = await carregarChart();
  const t = tema();
  const rotDif = `${tr("Avg diff")} (${unidade})`;
  const c = new Chart(canvas, {
    data: {
      labels: rotulos,
      datasets: [
        { type: "line", label: rotDif, data: difs, yAxisID: "y", borderColor: t.s1, backgroundColor: t.s1, borderWidth: 2,
          pointRadius: 3, pointHoverRadius: 5, pointBorderColor: t.sup, pointBorderWidth: 2, tension: 0, spanGaps: true, order: 0 },
        { type: "bar", label: tr("bags"), data: sacas, yAxisID: "y1", backgroundColor: t.grade, borderRadius: 3, maxBarThickness: 26, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { position: "left", grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 } },
          title: { display: true, text: rotDif, color: t.muda, font: { size: 11 } } },
        y1: { position: "right", grid: { display: false }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 }, callback: (v) => fmtK(v) },
          title: { display: true, text: tr("bags (60 kg)"), color: t.muda, font: { size: 11 } } },
      },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => (ctx.dataset.yAxisID === "y1"
          ? ` ${fmtN(ctx.raw)} ${tr("bags")}` : ` ${rotDif}: ${ctx.raw == null ? "—" : fmtSinalDec(ctx.raw)}`) } },
      },
    },
  });
  graficos.push(c);
}

async function painelDiffs(alvo, carga, ctx) {
  let dados;
  try { dados = (await ctx.api.positionDetalhe(["vendas"])).vendas ?? []; }
  catch (e) { alvo.innerHTML = `<div class="vazio">${icon("lock")}<h3>Export sale diffs unavailable</h3><p>${esc(e.message)}</p></div>`; return; }
  // dados gravados antes de a Data de Inclusão e o EOM Ship serem lidos da planilha
  if (!dados.some((r) => "eom_ship" in r)) {
    alvo.innerHTML = `<p class="muted pos-nota pos-nota-bloco">${icon("info")} Upload the Position again to build this view — it needs the inclusion date and the EOM Ship from the spreadsheet.</p>`;
    return;
  }
  for (const r of dados) {
    const porTon = /TON/i.test(r.unidade ?? "");
    r._sacas = r.saida > 0 ? r.saida : (r.sacas ?? 0);
    const dif = difExportacao(r);
    r._difClb = dif == null ? null : porTon ? dif * USDT_PARA_CLB : dif; // sempre em ¢/lb, como no card Export Sales
    r._bolsa = norm(r.bolsa);
  }

  const hoje = mesIso(hojeIso());
  let bolsa = "NY", base = "inclusao", agrupar = "padrao", eom = "";
  const padraoPeriodo = (b) => (b === "inclusao" ? [somaMes(hoje, -11), hoje] : [somaMes(hoje, -5), somaMes(hoje, 6)]);
  let [de, ate] = padraoPeriodo(base);

  const desenhar = async () => {
    limparGraficos();
    const unidade = "¢/lb";

    const daBolsa = dados.filter((r) => r._bolsa === bolsa);
    const opcoesEom = [...new Set(daBolsa.map((r) => mesIso(r.eom_ship)).filter(Boolean))].sort();
    if (eom && !opcoesEom.includes(eom)) eom = "";
    const chaveGrupo = (r) => (agrupar === "grupo" ? r.grupo : r.padrao) ?? "—";

    const noFiltro = daBolsa.filter((r) => !eom || mesIso(r.eom_ship) === eom);
    const semData = noFiltro.filter((r) => !r[base]).length;
    const linhas = noFiltro.filter((r) => { const m = mesIso(r[base]); return m && m >= de && m <= ate; })
      .map((r) => ({ ...r, _dif: r._difClb, _valor: 0, _mes: mesIso(r[base]) }));
    const comDif = linhas.filter((r) => r._dif != null);
    const semDif = linhas.length - comDif.length;

    const porMes = agregar(comDif, (r) => r._mes);
    const porGrupo = agregar(comDif, chaveGrupo);
    const porCelula = agregar(comDif, (r) => `${chaveGrupo(r)}\u0001${r._mes}`);
    const tudo = total(comDif);
    const grupos = [...porGrupo.entries()].sort((a, b) => b[1].sacas - a[1].sacas);
    const meses = mesesEntre(de, ate).filter((m) => porMes.has(m));
    const contratos = new Set(comDif.map((r) => r.contrato)).size;
    const dif = (a) => (media(a, "dif") == null ? "—" : fmtSinalDec(media(a, "dif")));
    const cel = (a, forte = false) => (a
      ? `<td class="num ${forte ? "forte" : ""}" title="${esc(fmtN(a.sacas))} ${esc(tr("bags"))}">${dif(a)}<small>${fmtK(a.sacas)}</small></td>`
      : `<td class="num"><span class="zero">–</span></td>`);
    const porQualidade = agrupar === "padrao";
    const rotBase = base === "inclusao" ? "Inclusion date" : "EOM Ship";

    alvo.innerHTML = `
    <div class="pos-filtros">
      ${segmentos("segBolsa", [["NY", "NY (Arabica)"], ["LONDRES", "London (Robusta)"]], bolsa)}
      ${segmentos("segBase", [["inclusao", "Inclusion date"], ["eom_ship", "EOM Ship"]], base)}
      <label class="pos-mes"><span>From</span><input type="month" id="fDe" value="${de}"></label>
      <label class="pos-mes"><span>To</span><input type="month" id="fAte" value="${ate}"></label>
      <select id="fEom" aria-label="EOM Ship"><option value="">All EOM Ship</option>${opcoesEom.map((m) => `<option value="${m}" ${m === eom ? "selected" : ""}>EOM ${esc(rotMes(m))}</option>`).join("")}</select>
      ${segmentos("segAgrupar", [["padrao", "Quality"], ["grupo", "Quality group"]], agrupar)}
    </div>
    <p class="muted pos-nota">${icon("info")} <span>${base === "inclusao" ? "Months counted by inclusion date." : "Months counted by EOM Ship."}</span> <span>Average weighted by bags; Conilon diffs ÷ 100.</span>${semDif ? ` <span>${fmtN(semDif)} rows without a diff left out.</span>` : ""}${semData ? ` <span>${fmtN(semData)} rows without a date left out.</span>` : ""}</p>
    <div class="pos-kpis">
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Avg diff · ${unidade}</span><span class="pos-kpi-v">${dif(tudo)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Bags</span><span class="pos-kpi-v">${fmtN(tudo.sacas)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Contracts</span><span class="pos-kpi-v">${fmtN(contratos)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">${porQualidade ? "Qualities" : "Quality groups"}</span><span class="pos-kpi-v">${fmtN(grupos.length)}</span></div>
    </div>

    <section class="pos-card">
      <div class="pos-card-h"><h2>${base === "inclusao" ? "Avg diff by month · Inclusion date" : "Avg diff by month · EOM Ship"}</h2>
        <p class="muted">Line: average sale diff. Bars: bags.</p></div>
      ${meses.length ? `<div class="pos-grafico pos-grafico-sm"><canvas id="gDiffs" role="img" aria-label="Average diff by month"></canvas></div>`
        : `<p class="vazio-td">No data for these filters.</p>`}
    </section>

    <section class="pos-card">
      <div class="pos-card-h"><h2>${porQualidade ? "Avg diff by quality and month" : "Avg diff by quality group and month"} · ${unidade}</h2>
        <p class="muted">Each cell: average diff and, below, the bags. Hover a cell for the exact volume.</p></div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num pos-diffs">
        <thead><tr><th>${porQualidade ? "Quality" : "Quality group"}</th>${meses.map((m) => `<th class="num">${esc(rotMes(m))}</th>`).join("")}<th class="num">Total</th></tr></thead>
        <tbody>${grupos.length ? grupos.map(([g, a]) => `<tr><td>${esc(g)}</td>${meses.map((m) => cel(porCelula.get(`${g}\u0001${m}`))).join("")}${cel(a, true)}</tr>`).join("")
          : `<tr><td colspan="${meses.length + 2}" class="vazio-td">No data for these filters.</td></tr>`}</tbody>
        ${grupos.length ? `<tfoot><tr class="total"><th scope="row">Total</th>${meses.map((m) => cel(porMes.get(m))).join("")}${cel(tudo, true)}</tr></tfoot>` : ""}
      </table></div>
    </section>`;

    ligarSegmentos(alvo, "segBolsa", (k) => { bolsa = k; eom = ""; desenhar(); });
    ligarSegmentos(alvo, "segBase", (k) => { if (k === base) return; base = k; [de, ate] = padraoPeriodo(base); desenhar(); });
    ligarSegmentos(alvo, "segAgrupar", (k) => { agrupar = k; desenhar(); });
    $("#fEom", alvo).addEventListener("change", (e) => { eom = e.target.value; desenhar(); });
    $("#fDe", alvo).addEventListener("change", (e) => { if (!e.target.value) return; de = e.target.value; if (de > ate) ate = de; desenhar(); });
    $("#fAte", alvo).addEventListener("change", (e) => { if (!e.target.value) return; ate = e.target.value; if (ate < de) de = ate; desenhar(); });

    if (meses.length) {
      await graficoDiffs($("#gDiffs", alvo), {
        rotulos: meses.map(rotMes), unidade,
        difs: meses.map((m) => { const v = media(porMes.get(m), "dif"); return v == null ? null : arred(v); }),
        sacas: meses.map((m) => arred(porMes.get(m).sacas)),
      });
    }
  };
  await desenhar();
}
