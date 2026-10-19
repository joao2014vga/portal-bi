// Position: painéis nativos do portal a partir da planilha diária
// "Brascof Position Overview" (.xlsm). O upload lê a planilha no próprio
// navegador (sem macros), extrai os resumos e os contratos em aberto e grava
// tudo no Supabase de uma vez (função bi_position_publicar).
//
// Painéis (link cadastrado em bi_dashboards):
//   portal:position-overview   posição por mês de vencimento + variação do dia
//   portal:position-physical   posição física por mês e por qualidade
//   portal:position-contracts  contratos em aberto, contrato a contrato
import { esc, $, $$, icon, toast, modal, tempoRelativo, dataBR } from "./ui.js";

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm";

export const ehPainelPosition = (link) => /^portal:position-/.test(link ?? "");

// =====================================================================
// LEITURA DA PLANILHA
// =====================================================================
const ABAS = {
  termm: "Position Overview TermM", fisica: "Physical Position", variacao: "Variation",
  purchases: "Purchases", expsales: "ExpSales", intsales: "IntSales", inventory: "Inventory",
};

const norm = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arred = (v) => Math.round(v * 100) / 100;
const vazia = (l) => l.every((v) => v == null || String(v).trim() === "");
// datas do Excel chegam como número de série (dias desde 30/12/1899)
const serialIso = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5).toISOString().slice(0, 10);

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

// Blocos achados pelo título (não pela linha), para aguentar linhas inseridas.
const GRUPOS = [["arabica", /^ARABICA/], ["robusta", /^ROBUSTA/], ["exportable", /^EXPORTABLE/], ["lowgrade", /^LOW GRADE/]];

// Position Overview TermM: colunas B..R de cada bloco
const COLS_TERMM = ["cash", "purchases", "purchases_fixed", "purchases_ptbf", "inventory", "sales", "exp_sales", "exp_fixed",
  "exp_ptbf", "int_sales", "int_fixed", "int_ptbf", "futures", "futures_ptbf", "switch_exp", "net_diff", "net_outright"];

function lerTermM(g) {
  const out = {};
  g.forEach((l, i) => {
    const grupo = GRUPOS.find(([, re]) => re.test(norm(l[0])))?.[0];
    if (!grupo || out[grupo] || norm(l[1]) !== "CASH") return;
    const h = l.map(norm);
    if (h[2] !== "PURCHASES" || h[5] !== "INVENTORY" || h[6] !== "SALES" || h[7] !== "EXP SALES" || h[10] !== "INT SALES"
      || h[13] !== "FUTURES" || !h[16].startsWith("NET DIFF") || !h[17].startsWith("NET OUTRIGHT")) {
      throw new Error(`"${ABAS.termm}": unexpected columns in the ${l[0]} block.`);
    }
    const linha = (r) => Object.fromEntries(COLS_TERMM.map((k, j) => [k, arred(num(r[j + 1]) ?? 0)]));
    const meses = [];
    let total = null;
    for (let k = i + 1; k < g.length; k++) {
      const r = g[k];
      if (vazia(r)) { if (meses.length) break; continue; }
      if (num(r[0]) != null) { meses.push({ mes: serialIso(r[0]), ...linha(r) }); continue; }
      if (num(r[1]) != null) total = linha(r);
      break;
    }
    if (!total) throw new Error(`"${ABAS.termm}": total row of the ${l[0]} block not found.`);
    out[grupo] = { meses, total };
  });
  for (const [k] of GRUPOS) if (!out[k]) throw new Error(`"${ABAS.termm}": block "${k}" not found.`);
  return out;
}

// Physical Position: blocos Exportable / Low Grade por mês + matriz mês × qualidade
function lerFisica(g) {
  const out = {};
  g.forEach((l, i) => {
    const grupo = /^EXPORTABLE/.test(norm(l[0])) ? "exportable" : /^LOW GRADE/.test(norm(l[0])) ? "lowgrade" : null;
    if (!grupo || out[grupo] || norm(l[1]) !== "INVENTORY") return;
    const h = l.map(norm);
    if (h[2] !== "PURCHASES" || h[3] !== "EXP SALES" || !h[4].startsWith("DOMESTIC") || h[5] !== "NET") {
      throw new Error(`"${ABAS.fisica}": unexpected columns in the ${l[0]} block.`);
    }
    const linha = (r) => ({
      inventory: arred(num(r[1]) ?? 0), purchases: arred(num(r[2]) ?? 0), exp_sales: arred(num(r[3]) ?? 0),
      domestic_sales: arred(num(r[4]) ?? 0), net: arred(num(r[5]) ?? 0),
    });
    const meses = [];
    let total = null;
    for (let k = i + 1; k < g.length; k++) {
      const r = g[k];
      if (vazia(r.slice(0, 6))) { if (meses.length) break; continue; }
      if (num(r[0]) != null) { meses.push({ mes: serialIso(r[0]), ...linha(r) }); continue; }
      if (norm(r[0]) === "TOTAL") total = linha(r);
      break;
    }
    out[grupo] = { meses, total };
  });
  if (!out.exportable) throw new Error(`"${ABAS.fisica}": EXPORTABLE block not found.`);

  // matriz por qualidade: duas tabelas lado a lado (com e sem compras), cada uma de BCSW até TOTAL
  const iH = g.findIndex((l) => l.filter((v) => norm(v) === "BCSW").length >= 2);
  if (iH >= 0) {
    const h = g[iH].map(norm);
    const ini1 = h.indexOf("BCSW"), fim1 = h.indexOf("TOTAL", ini1);
    const ini2 = h.indexOf("BCSW", fim1), fim2 = h.indexOf("TOTAL", ini2);
    if (ini1 > 0 && fim1 > ini1 && ini2 > fim1 && fim2 - ini2 === fim1 - ini1) {
      const ler = (ini, fim) => {
        const linhas = [];
        for (let k = iH + 1; k < g.length; k++) {
          const m = num(g[k][ini - 1]);
          if (m == null) { if (linhas.length) break; continue; }
          linhas.push({ mes: serialIso(m), v: g[k].slice(ini, fim + 1).map((x) => arred(num(x) ?? 0)) });
        }
        return linhas;
      };
      out.qualidades = { colunas: g[iH].slice(ini1, fim1 + 1).map((x) => String(x).trim()), com: ler(ini1, fim1), sem: ler(ini2, fim2) };
    }
  }
  return out;
}

// Variation: Previous → movimentos do dia → posição atual, por grupo
function lerVariacao(g) {
  const nomes = { ARABICA: "arabica", CONILON: "robusta", EXP: "exportable", "LOW GRADE": "lowgrade" };
  const out = {};
  for (let i = 0; i < g.length; i++) {
    for (let c = 0; c < g[i].length; c++) {
      const chave = nomes[norm(g[i][c])];
      if (!chave || out[chave] || !norm(g[i][c + 1]).startsWith("NET DIFF")) continue;
      const itens = [];
      let total = null;
      for (let k = i + 1; k < g.length; k++) {
        const r = g[k], rot = String(r[c] ?? "").trim(), d = num(r[c + 1]), o = num(r[c + 2]);
        if (rot) { if (d != null || o != null) itens.push({ rotulo: rot, diff: arred(d ?? 0), outright: arred(o ?? 0) }); continue; }
        if (d != null || o != null) total = { diff: arred(d ?? 0), outright: arred(o ?? 0) };
        break;
      }
      if (total && itens.length) out[chave] = { itens, total };
    }
  }
  return out;
}

// Contratos: só as colunas usadas no portal, e só o que está em aberto
const DETALHES = {
  purchases: {
    aba: ABAS.purchases,
    cols: [["contrato", "Contrato"], ["fornecedor", "Fornecedor"], ["modalidade", "Modalidade CTR"], ["sacas", "Sacas Total", "n"],
      ["emissao", "Emissão", "d"], ["prev_entrega", "Prev. de Entrega", "d"], ["a_entregar", "A Entregar BC", "n"],
      ["padrao", "Padrão"], ["bebida", "Bebida"], ["preco", "Média Final (R$)", "n"], ["a_pagar", "A Pagar (R$)", "n"],
      ["status_fix", "Status Fixação"], ["bolsa", "Bolsa"], ["mes_bolsa", "Mês Bolsa", "d"], ["diferencial", "Diferencial", "n"],
      ["a_fixar", "Qtd, a Fixar", "n"], ["fixador", "Fixador"], ["lotes", "Qtd. Lotes", "n"], ["lotes_fixados", "Lotes Fixado", "n"],
      ["lotes_a_fixar", "Lotes a Fixar", "n"], ["certificador", "Certificador"], ["especie", "Espécie"], ["safra", "Safra"]],
    aberto: (r) => r.a_entregar > 0 || r.a_fixar > 0 || r.a_pagar > 1,
  },
  expsales: {
    aba: ABAS.expsales,
    cols: [["contrato", "Contrato"], ["importador", "Importador"], ["embarque", "Embarque", "d"], ["sacas", "Sacas", "n"],
      ["a_fixar", "Qtd. a Fixar (sc)", "n"], ["status_fix", "Status Fixação"], ["bolsa", "Bolsa"], ["fixar_mes", "Fixar Mês", "d"],
      ["fixador", "Opção de Fixação"], ["lotes", "Qtd. Lotes", "n"], ["lotes_fixados", "Lotes Fixado", "n"], ["lotes_a_fixar", "Lotes a Fixar", "n"],
      ["diferencial", "Diferencial", "n"], ["vlr_final", "Vlr. Final", "n"], ["unidade", "Unidade"], ["padrao", "Padrão"],
      ["prev_carga", "Prev. Carga", "d"], ["saldo", "Saldo (sc)", "n"], ["certificacao", "Certificação"], ["incoterm", "Incoterm"],
      ["especie", "Espécie"], ["safra", "Safras"]],
    aberto: (r) => r.saldo > 0 || r.a_fixar > 0,
  },
  intsales: {
    aba: ABAS.intsales,
    cols: [["contrato", "Contrato"], ["cliente", "Cliente"], ["emissao", "Emissão", "d"], ["sacas", "Sacas Total", "n"],
      ["a_entregar", "A Entregar(Sc)", "n"], ["preco", "Unitário R$", "n"], ["a_receber", "A Receber (R$)", "n"],
      ["status_fix", "Status Fixação"], ["bolsa", "Bolsa"], ["fixar_mes", "Fixar Mês", "d"], ["a_fixar", "Qtd, a Fixar", "n"],
      ["fixador", "Fixador"], ["lotes", "Qtd. Lotes", "n"], ["lotes_fixados", "Lotes Fixado", "n"], ["lotes_a_fixar", "Lotes a Fixar", "n"],
      ["padrao", "Padrão"],
      ["prev_embarque", "Prev. Embarque", "d"], ["modalidade", "Modalidade CTR"], ["especie", "Espécie"], ["safra", "Safra"]],
    aberto: (r) => r.a_entregar > 0 || r.a_fixar > 0 || r.a_receber > 1,
  },
  // histórico para os cards "crop over crop": vendas realizadas (com BL) e todas as compras
  vendas: {
    aba: ABAS.expsales,
    cols: [["contrato", "Contrato"], ["alertas", "Alertas"], ["referencia", "Referência"], ["sacas", "Sacas", "n"], ["saida", "Saída (sc)", "n"],
      ["data_bl", "Data BL", "d"], ["safra", "Safras"], ["padrao", "Padrão"], ["grupo", "Quality Group"], ["especie", "Espécie"],
      ["bolsa", "Bolsa"], ["unidade", "Unidade"], ["diferencial", "Diferencial", "n"], ["vlr_final", "Vlr. Final", "n"],
      ["valor_usd", "Valor Contrato (US$)", "n"]],
    aberto: (r) => !!r.data_bl,
  },
  compras: {
    aba: ABAS.purchases,
    cols: [["contrato", "Contrato"], ["fornecedor", "Fornecedor"], ["emissao", "Emissão", "d"], ["safra", "Safra"], ["sacas", "Sacas Total", "n"],
      ["padrao", "Padrão"], ["especie", "Espécie"], ["bolsa", "Bolsa"], ["modalidade", "Modalidade CTR"], ["diferencial", "Diferencial", "n"],
      ["preco", "Média Final (R$)", "n"], ["valor", "Valor Final (R$)", "n"]],
    aberto: (r) => !!r.safra && r.sacas > 0,
  },
  inventory: {
    aba: ABAS.inventory,
    cols: [["lote", "Lote/Guia"], ["tipo", "Tipo"], ["sacas", "Sacas 60kg", "n"], ["padrao", "Padrão"], ["bebida", "Bebida"],
      ["peneiras", "Peneiras"], ["especie", "Espécie"], ["safra", "Safra"], ["armazem", "Armazém"], ["filial", "Filial"],
      ["certificador", "Certificador"], ["custo", "Custo R$", "n"], ["entrada", "Data Entrada", "d"], ["contrato", "Contrato"]],
    aberto: () => true,
  },
};

function lerDetalhe(g, def) {
  const cab = (g[0] ?? []).map(norm);
  const idx = def.cols.map(([k, titulo, tipo]) => {
    const i = cab.indexOf(norm(titulo));
    if (i < 0) throw new Error(`"${def.aba}": column "${titulo}" not found.`);
    return [k, i, tipo];
  });
  const linhas = [];
  for (const r of g.slice(1)) {
    if (vazia(r) || String(r[idx[0][1]] ?? "").trim() === "") continue;
    const o = {};
    for (const [k, i, tipo] of idx) {
      const v = r[i];
      o[k] = tipo === "n" ? (num(v) == null ? null : arred(v))
        : tipo === "d" ? (num(v) == null ? null : serialIso(v))
        : (v == null || String(v).trim() === "" ? null : String(v).trim());
    }
    if (def.aberto(o)) linhas.push(o);
  }
  return linhas;
}

export async function lerPlanilhaPosition(file) {
  const XLSX = await carregarXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), {
    type: "array", sheets: Object.values(ABAS), cellFormula: false, cellHTML: false, cellText: false, cellStyles: false,
  });
  const faltam = Object.values(ABAS).filter((n) => !wb.Sheets[n]);
  if (faltam.length) throw new Error(`Sheet(s) not found: ${faltam.join(", ")}. Is this the Position Overview spreadsheet?`);
  const g = (k) => grade(XLSX, wb.Sheets[ABAS[k]]);

  const gTermM = g("termm");
  const serial = num(gTermM[0]?.[0]);
  if (serial == null) throw new Error(`"${ABAS.termm}": the "updated as of" date in cell A1 was not found.`);
  const termm = lerTermM(gTermM);
  const resumo = {
    versao: 1,
    termm,
    fisica: lerFisica(g("fisica")),
    variacao: lerVariacao(g("variacao")),
    kpis: Object.fromEntries(Object.entries(termm).map(([k, b]) => [k, { diff: b.total.net_diff, outright: b.total.net_outright }])),
  };
  // cada aba vira matriz uma vez só (vendas e expsales, por exemplo, usam a mesma)
  const grades = new Map();
  const gAba = (nome) => (grades.has(nome) ? grades.get(nome) : grades.set(nome, grade(XLSX, wb.Sheets[nome])).get(nome));
  const detalhes = Object.fromEntries(Object.entries(DETALHES).map(([k, def]) => [k, lerDetalhe(gAba(def.aba), def)]));
  return { data_ref: serialIso(serial), resumo, detalhes };
}

// =====================================================================
// FORMATAÇÃO E GRÁFICOS
// =====================================================================
const fmtN = (v, dec = 0) => (v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const fmtSinal = (v) => (v > 0 ? "+" : "") + fmtN(v);
const fmtMes = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", "-") : "—");
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
        { type: "line", label: linha.rotulo, data: linha.dados, borderColor: t.tinta, backgroundColor: t.tinta, borderWidth: 2,
          pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: t.tinta, pointBorderColor: t.sup, pointBorderWidth: 2, tension: 0, order: 0 },
        ...series.map((s, i) => ({
          type: "bar", label: s.rotulo, data: s.dados, backgroundColor: cores[i], borderColor: t.sup, borderWidth: 1,
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
          title: { display: true, text: "bags (60 kg)", color: t.muda, font: { size: 11 } } },
      },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtN(ctx.raw)} bags` } },
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
    data: { labels: rotulos, datasets: [{ label: rotulo, data: dados, borderColor: t.s1, backgroundColor: t.s1, borderWidth: 2,
      pointRadius: 3, pointHoverRadius: 5, pointBorderColor: t.sup, pointBorderWidth: 2, tension: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 }, callback: (v) => fmtK(v) } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${rotulo}: ${fmtN(ctx.raw)} bags` } } },
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
// ctx = { api, gerente (pode publicar), recarregar }
export async function renderPosition(link, alvo, ctx) {
  limparGraficos();
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading Position…</div>`;
  let carga;
  try { carga = await ctx.api.positionUltima(); }
  catch (e) {
    alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Position data is not available</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  const topo = barraTopo(carga, ctx);
  if (!carga) {
    alvo.innerHTML = `<div class="pos">${topo}<div class="vazio">${icon("chart")}<h3>No Position uploaded yet</h3>
      <p>${ctx.gerente ? "Upload the daily Position Overview spreadsheet to build these views." : "The BI team has not published the Position yet."}</p></div></div>`;
    ligarUpload(alvo, ctx);
    return;
  }
  const painel = {
    "portal:position-overview": painelOverview, "portal:position-physical": painelFisica, "portal:position-contracts": painelContratos,
    "portal:position-sales": painelVendas, "portal:position-purchases": painelCompras,
  }[link];
  if (!painel) { alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Unknown Position view</h3></div>`; return; }
  alvo.innerHTML = `<div class="pos">${topo}<div id="posCorpo"></div></div>`;
  ligarUpload(alvo, ctx);
  await painel($("#posCorpo", alvo), carga, ctx);
}

function barraTopo(carga, ctx) {
  return `<div class="pos-topo">
    <div class="pos-data">${icon("clock")}${carga
      ? `<span>Position as of <strong>${esc(fmtData(carga.data_ref))}</strong> · uploaded ${esc(tempoRelativo(carga.created_at))}${carga.enviado_por ? ` by ${esc(carga.enviado_por)}` : ""}</span>`
      : `<span>No Position uploaded yet</span>`}<span class="muted">· all figures in 60 kg bags</span></div>
    ${ctx.gerente ? `<button class="btn btn-primary" id="posUpload">${icon("upload")}<span>Upload Position</span></button>` : ""}
  </div>`;
}

function ligarUpload(alvo, ctx) {
  $("#posUpload", alvo)?.addEventListener("click", () => modal({
    titulo: "Upload Position",
    botao: "Read and publish",
    corpo: `<p class="muted">Choose the daily <strong>Brascof Position Overview</strong> spreadsheet (.xlsm or .xlsx).
      It is read in your browser — macros are never run — and the Position views are updated for everyone with access.</p>
      <label class="campo"><span>Spreadsheet *</span><input type="file" name="arquivo" accept=".xlsm,.xlsx" required></label>`,
    async onSubmit(f) {
      const file = f.arquivo.files[0];
      if (!file) throw new Error("Please choose the spreadsheet.");
      const lida = await lerPlanilhaPosition(file);
      // contratos vencidos ou a vencer em 15 dias viram notificação para quem vê o Open Contracts
      await ctx.api.publicarPosition({ ...lida, nome_arquivo: file.name, alerta: textoAlertaFixacao(lida.detalhes) });
      toast(`Position of ${fmtData(lida.data_ref)} published.`);
      ctx.recarregar();
    },
  }));
}

// ---------------------------------------------------------------- Overview
async function painelOverview(alvo, carga, ctx) {
  const { termm, variacao, kpis } = carga.resumo;
  let grupo = "arabica";
  const historico = await ctx.api.positionHistorico().catch(() => []);

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
    </div>`;

    $$("[data-grupo]", alvo).forEach((el) => el.addEventListener("click", () => { grupo = el.dataset.grupo; desenhar(); }));
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

function linhaTermM(rotulo, m, total = false) {
  const tag = total ? "th" : "td";
  return `<tr class="${total ? "total" : ""}"><${tag} scope="row">${esc(rotulo)}</${tag}>${[
    m.cash, m.purchases, m.purchases_fixed, m.purchases_ptbf, m.inventory, m.sales, m.exp_sales, m.exp_fixed, m.exp_ptbf,
    m.int_sales, m.int_fixed, m.int_ptbf, m.futures, m.futures_ptbf, m.switch_exp,
  ].map((v) => celNum(v, { forte: total })).join("")}${celNum(m.net_diff, { forte: true })}${celNum(m.net_outright, { forte: true })}</tr>`;
}

// ---------------------------------------------------------------- Physical
async function painelFisica(alvo, carga) {
  const f = carga.resumo.fisica;
  const grupos = ["exportable", "lowgrade"].filter((k) => f[k]);
  let grupo = grupos[0];
  let matriz = "com";

  const desenhar = async () => {
    limparGraficos();
    const b = f[grupo];
    const q = f.qualidades;
    const linhasQ = q?.[matriz] ?? [];
    const maxAbs = Math.max(1, ...linhasQ.flatMap((l) => l.v.slice(0, -1).map(Math.abs)));

    alvo.innerHTML = `
    <div class="pos-filtros">${segmentos("segGrupo", grupos.map((k) => [k, NOME_GRUPO[k]]), grupo)}</div>
    <section class="pos-card">
      <div class="pos-card-h"><h2>Physical position by month · ${NOME_GRUPO[grupo]}</h2>
        <p class="muted">Bars: inventory, purchases and sales (export + domestic) of each month. Line: running net physical position.</p></div>
      <div class="pos-grafico"><canvas id="gFis" role="img" aria-label="Physical position by month"></canvas></div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead><tr><th>Month</th><th>Inventory</th><th>Purchases</th><th>Exp sales</th><th>Domestic sales</th><th>Net (running)</th></tr></thead>
        <tbody>${b.meses.map((m) => `<tr><td>${fmtMes(m.mes)}</td>${celNum(m.inventory)}${celNum(m.purchases)}${celNum(m.exp_sales)}${celNum(m.domestic_sales)}${celNum(m.net, { forte: true })}</tr>`).join("")}</tbody>
        ${b.total ? `<tfoot><tr class="total"><th scope="row">Total</th>${celNum(b.total.inventory, { forte: true })}${celNum(b.total.purchases, { forte: true })}${celNum(b.total.exp_sales, { forte: true })}${celNum(b.total.domestic_sales, { forte: true })}${celNum(b.total.net, { forte: true })}</tr></tfoot>` : ""}
      </table></div>
    </section>

    ${q ? `<section class="pos-card">
      <div class="pos-card-h pos-card-h-linha"><div><h2>Running position by quality</h2>
        <p class="muted">Cumulative balance per month for each quality. <span class="pos-legenda"><i class="pos-pos"></i>long</span><span class="pos-legenda"><i class="pos-neg"></i>short</span></p></div>
        ${segmentos("segMatriz", [["com", "Including purchases"], ["sem", "Without purchases"]], matriz)}</div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num pos-matriz">
        <thead><tr><th>Month</th>${q.colunas.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${linhasQ.map((l) => `<tr><td>${fmtMes(l.mes)}</td>${l.v.map((v, i) => {
          const total = i === l.v.length - 1;
          const a = total ? 0 : Math.min(1, Math.abs(v) / maxAbs);
          const fundo = total || !v ? "" : `style="--a:${(0.08 + a * 0.5).toFixed(2)}"`;
          return `<td class="num ${total ? "forte" : v > 0 ? "cel-pos" : v < 0 ? "cel-neg" : ""}" ${fundo}>${v === 0 ? `<span class="zero">–</span>` : fmtN(v)}</td>`;
        }).join("")}</tr>`).join("")}</tbody>
      </table></div>
    </section>` : ""}`;

    ligarSegmentos(alvo, "segGrupo", (k) => { grupo = k; desenhar(); });
    ligarSegmentos(alvo, "segMatriz", (k) => { matriz = k; desenhar(); });
    await graficoBarrasLinha($("#gFis", alvo), {
      meses: b.meses.map((m) => m.mes),
      series: [
        { rotulo: "Purchases", dados: b.meses.map((m) => m.purchases) },
        { rotulo: "Inventory", dados: b.meses.map((m) => m.inventory) },
        { rotulo: "Sales", dados: b.meses.map((m) => arred(m.exp_sales + m.domestic_sales)) },
      ],
      linha: { rotulo: "Net (running)", dados: b.meses.map((m) => m.net) },
    });
  };
  await desenhar();
}

// ---------------------------------------------------------------- Contracts
// Prazo de fixação = First Notice Day (FND) estimado do mês da bolsa:
// N dias úteis antes do 1º dia útil do mês (feriados não considerados).
// NY (Coffee "C"): 7 dias úteis · Londres (Robusta): 4 · outras bolsas: 1º dia útil do mês.
const DIAS_FND = { NY: 7, "NEW YORK": 7, LONDRES: 4, LONDON: 4, LDN: 4 };
const ALERTA_DIAS = 15, AVISO_DIAS = 30;

function primeiroAviso(mesIso, bolsa) {
  const d = new Date(`${mesIso.slice(0, 7)}-01T12:00:00Z`);
  const util = () => d.getUTCDay() % 6 !== 0;
  while (!util()) d.setUTCDate(d.getUTCDate() + 1);
  for (let n = DIAS_FND[norm(bolsa)] ?? 0; n > 0;) { d.setUTCDate(d.getUTCDate() - 1); if (util()) n--; }
  return d.toISOString().slice(0, 10);
}
const hojeIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const diasAte = (iso) => Math.round((new Date(iso + "T12:00:00") - new Date(hojeIso() + "T12:00:00")) / 864e5);

// mês da bolsa de cada tipo de contrato
const CAMPO_MES = { purchases: "mes_bolsa", expsales: "fixar_mes", intsales: "fixar_mes" };

// Situação de fixação de um contrato com lotes a fixar (null quando não há o que fixar)
function prazoFixacao(r, tipo) {
  if (!(r.lotes_a_fixar > 0) || !r[CAMPO_MES[tipo]]) return null;
  const data = primeiroAviso(r[CAMPO_MES[tipo]], r.bolsa);
  const dias = diasAte(data);
  return { data, dias, nivel: dias < 0 ? "vencido" : dias <= ALERTA_DIAS ? "urgente" : dias <= AVISO_DIAS ? "breve" : "ok" };
}

// Contratos/lotes vencidos, em até 15 e em até 30 dias, somando compras e vendas
export function alertasFixacao(detalhes) {
  const r = { vencido: { c: 0, l: 0, tipos: {} }, urgente: { c: 0, l: 0, tipos: {} }, breve: { c: 0, l: 0, tipos: {} } };
  for (const tipo of Object.keys(CAMPO_MES)) {
    for (const linha of detalhes[tipo] ?? []) {
      const p = prazoFixacao(linha, tipo);
      if (!p || !r[p.nivel]) continue;
      r[p.nivel].c++; r[p.nivel].l += linha.lotes_a_fixar;
      r[p.nivel].tipos[tipo] = (r[p.nivel].tipos[tipo] ?? 0) + 1;
    }
  }
  return r;
}

// Texto da notificação do upload (null quando não há nada vencido ou em até 15 dias)
export function textoAlertaFixacao(detalhes) {
  const a = alertasFixacao(detalhes);
  const partes = [];
  if (a.vencido.c) partes.push(`${a.vencido.c} ${a.vencido.c === 1 ? "contract" : "contracts"} (${fmtLotes(a.vencido.l)} lots) past the first notice day`);
  if (a.urgente.c) partes.push(`${a.urgente.c} ${a.urgente.c === 1 ? "contract" : "contracts"} (${fmtLotes(a.urgente.l)} lots) due within ${ALERTA_DIAS} days`);
  return partes.length ? `Lots to fix: ${partes.join(" · ")}` : null;
}

// lotes: inteiro quando a fração é desprezível (somas como 2611.97 viram 2,612)
const contratos = (n) => `${fmtN(n)} ${n === 1 ? "contract" : "contracts"}`;
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
  const temLotes = (detalhes.purchases ?? []).some((r) => "lotes_a_fixar" in r);
  const alertas = alertasFixacao(detalhes);
  let aba = "purchases", busca = "", especie = "", qualidade = "", mes = "", fix = "", ordem = null;

  const desenhar = () => {
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
      ${segmentos("segAba", Object.entries(TABELAS).map(([k, d]) => [k, `${d.titulo} (${(detalhes[k] ?? []).length})`]), aba)}
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
const rotuloPosicao = (k) => (k < 0 ? "Earlier" : k > 11 ? "Later" : MESES_SAFRA[k]);

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
function agregar(linhas, chave) {
  const m = new Map();
  for (const r of linhas) {
    const k = chave(r);
    const a = m.get(k) ?? { sacas: 0, valor: 0, difPeso: 0, difSacas: 0, precoPeso: 0, precoSacas: 0, n: 0 };
    a.sacas += r._sacas; a.valor += r._valor; a.n++;
    if (r._dif != null) { a.difPeso += r._dif * r._sacas; a.difSacas += r._sacas; }
    if (r._preco != null) { a.precoPeso += r._preco * r._sacas; a.precoSacas += r._sacas; }
    m.set(k, a);
  }
  return m;
}
const VAZIO = { sacas: 0, valor: 0, difPeso: 0, difSacas: 0, precoPeso: 0, precoSacas: 0, n: 0 };
const total = (linhas) => agregar(linhas, () => 0).get(0) ?? VAZIO;
const media = (a, campo) => (a?.[campo + "Sacas"] ? a[campo + "Peso"] / a[campo + "Sacas"] : null);

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
        { label: rotAnterior, data: anterior, backgroundColor: t.muda, borderRadius: 3, maxBarThickness: 26 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 }, callback: (v) => fmtK(v) },
          title: { display: true, text: "bags (60 kg)", color: t.muda, font: { size: 11 } } },
      },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtN(ctx.raw)} bags` } },
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
  let bolsa = "NY", extra = "", ranking = cfg.rankings[0][0];

  const desenhar = async () => {
    limparGraficos();
    const base = dados.filter((r) => r._pos != null && (!bolsa || norm(r.bolsa) === bolsa) && (!extra || cfg.extra.valor(r) === extra));
    const atual = base.filter((r) => r.safra === safra);
    const ant = safraAnterior(safra);
    // safra em andamento (ou futura): compara com o mesmo período da anterior, até o mês de hoje
    const posHoje = posicaoSafra(hoje, safra);
    const emAndamento = posHoje <= 11;
    const limite = emAndamento ? posHoje : 12;
    const anterior = base.filter((r) => r.safra === ant && r._pos <= limite);
    const periodo = !emAndamento ? "full crop" : limite >= 0 ? `Jul–${MESES_SAFRA[limite]}, same period` : "same period, before the crop year";
    const tA = total(atual), tP = total(anterior);
    const temDif = !!bolsa;
    const unDif = cfg.unidadeDif(bolsa);

    // tabela por mês (posição na safra)
    const mA = agregar(atual, (r) => r._pos), mP = agregar(anterior, (r) => r._pos);
    const posicoes = [...new Set([...mA.keys(), ...mP.keys()])].sort((a, b) => a - b);
    const maxMes = Math.max(1, ...[...mA.values()].map((a) => a.sacas));

    // ranking
    const [rk, , rkCampo] = cfg.rankings.find(([k]) => k === ranking);
    const rA = agregar(atual, rkCampo), rP = agregar(anterior, rkCampo);
    const itens = [...rA.entries()].sort((a, b) => b[1].sacas - a[1].sacas);
    const maxRk = Math.max(1, ...itens.map(([, a]) => a.sacas));
    const opcoesExtra = [...new Set(dados.filter((r) => !bolsa || norm(r.bolsa) === bolsa).map(cfg.extra.valor).filter(Boolean))].sort();

    const tileK = (titulo, valor, py, delta) => `<div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">${titulo}</span>
      <span class="pos-kpi-v">${valor}</span><span class="pos-kpi-s">PY: ${py} ${delta}</span></div>`;

    alvo.innerHTML = `
    <div class="pos-filtros">
      <select id="fSafra" aria-label="Crop">${safras.slice().reverse().map((s) => `<option ${s === safra ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      ${segmentos("segBolsa", [["NY", "NY (Arabica)"], ["LONDRES", "London (Robusta)"], ["", "All"]], bolsa)}
      <select id="fExtra" aria-label="${esc(cfg.extra.rotulo)}"><option value="">${esc(cfg.extra.todos)}</option>${opcoesExtra.map((v) => `<option ${v === extra ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <span class="muted pos-nota">Compared with ${esc(ant ?? "—")} · ${periodo}</span>
    </div>
    <div class="pos-kpis">
      ${tileK(`${cfg.rotVolume} · bags`, fmtN(tA.sacas), fmtN(tP.sacas), yoy(tA.sacas, tP.sacas))}
      ${tileK(cfg.rotValor, fmtDin(tA.valor, cfg.moeda), fmtDin(tP.valor, cfg.moeda), yoy(tA.valor, tP.valor))}
      ${tileK(`${cfg.rotPreco}`, media(tA, "preco") == null ? "—" : fmtN(media(tA, "preco"), 2), media(tP, "preco") == null ? "—" : fmtN(media(tP, "preco"), 2), yoy(media(tA, "preco"), media(tP, "preco"), { abs: true }))}
      ${tileK(`${cfg.rotDif} · ${unDif}`, temDif && media(tA, "dif") != null ? fmtSinalDec(media(tA, "dif")) : "—",
        temDif && media(tP, "dif") != null ? fmtSinalDec(media(tP, "dif")) : "—", temDif ? yoy(media(tA, "dif"), media(tP, "dif"), { abs: true }) : `<span class="muted">select an exchange</span>`)}
    </div>

    <section class="pos-card">
      <div class="pos-card-h"><h2>${esc(cfg.rotVolume)} by month · ${esc(safra)} vs ${esc(ant ?? "—")}</h2>
        <p class="muted">${esc(cfg.notaMes)}</p></div>
      <div class="pos-grafico pos-grafico-sm"><canvas id="gSafra" role="img" aria-label="${esc(cfg.rotVolume)} by month, this crop and previous crop"></canvas></div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead><tr><th>Month</th><th class="num">Volume</th><th class="num">PY</th><th class="num">YOY</th>
          <th class="num">${esc(cfg.rotValor)}</th><th class="num">PY</th><th class="num">YOY</th>
          <th class="num">${esc(cfg.rotDif)}</th><th class="num">PY</th><th class="num">Δ</th></tr></thead>
        <tbody>${posicoes.map((p) => { const a = mA.get(p) ?? VAZIO, b = mP.get(p); return `<tr><td>${rotuloPosicao(p)}</td>
          <td class="num">${barra(a.sacas, maxMes)}</td><td class="num">${b ? fmtN(b.sacas) : "—"}</td><td class="num">${yoy(a.sacas, b?.sacas)}</td>
          <td class="num">${fmtDin(a.valor, cfg.moeda)}</td><td class="num">${b ? fmtDin(b.valor, cfg.moeda) : "—"}</td><td class="num">${yoy(a.valor, b?.valor)}</td>
          <td class="num">${temDif && media(a, "dif") != null ? fmtSinalDec(media(a, "dif")) : "—"}</td><td class="num">${temDif && media(b, "dif") != null ? fmtSinalDec(media(b, "dif")) : "—"}</td>
          <td class="num">${temDif ? yoy(media(a, "dif"), media(b, "dif"), { abs: true }) : "—"}</td></tr>`; }).join("")}</tbody>
        <tfoot><tr class="total"><th scope="row">Total</th><td class="num">${fmtN(tA.sacas)}</td><td class="num">${fmtN(tP.sacas)}</td><td class="num">${yoy(tA.sacas, tP.sacas)}</td>
          <td class="num">${fmtDin(tA.valor, cfg.moeda)}</td><td class="num">${fmtDin(tP.valor, cfg.moeda)}</td><td class="num">${yoy(tA.valor, tP.valor)}</td>
          <td class="num">${temDif && media(tA, "dif") != null ? fmtSinalDec(media(tA, "dif")) : "—"}</td><td class="num">${temDif && media(tP, "dif") != null ? fmtSinalDec(media(tP, "dif")) : "—"}</td>
          <td class="num">${temDif ? yoy(media(tA, "dif"), media(tP, "dif"), { abs: true }) : "—"}</td></tr></tfoot>
      </table></div>
    </section>

    <section class="pos-card">
      <div class="pos-card-h pos-card-h-linha"><div><h2>Report by ${esc(cfg.rankings.find(([k]) => k === ranking)[1].toLowerCase())} · ${esc(safra)}</h2>
        <p class="muted">Volume share and change vs ${esc(ant ?? "—")} (${periodo}).${cfg.dicaRanking ? ` ${esc(cfg.dicaRanking)}` : ""}</p></div>
        ${segmentos("segRk", cfg.rankings.map(([k, t2]) => [k, t2]), ranking)}</div>
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead><tr><th>${esc(cfg.rankings.find(([k]) => k === ranking)[1])}</th><th class="num">Volume</th><th class="num">%</th><th class="num">YOY</th>
          <th class="num">${esc(cfg.rotValor)}</th><th class="num">YOY</th><th class="num">${esc(cfg.rotDif)}</th><th class="num">Δ PY</th></tr></thead>
        <tbody>${itens.length ? itens.map(([k, a]) => { const b = rP.get(k); return `<tr ${cfg.extra.campo === rk ? `class="clicavel" data-extra="${esc(k)}"` : ""}><td>${esc(k)}</td>
          <td class="num">${barra(a.sacas, maxRk)}</td><td class="num">${fmtN(tA.sacas ? (a.sacas / tA.sacas) * 100 : 0, 1)}%</td><td class="num">${yoy(a.sacas, b?.sacas)}</td>
          <td class="num">${fmtDin(a.valor, cfg.moeda)}</td><td class="num">${yoy(a.valor, b?.valor)}</td>
          <td class="num">${temDif && media(a, "dif") != null ? fmtSinalDec(media(a, "dif")) : "—"}</td>
          <td class="num">${temDif ? yoy(media(a, "dif"), media(b, "dif"), { abs: true }) : "—"}</td></tr>`; }).join("")
          : `<tr><td colspan="8" class="vazio-td">No data for these filters.</td></tr>`}</tbody>
      </table></div>
    </section>`;

    $("#fSafra", alvo).addEventListener("change", (e) => { safra = e.target.value; desenhar(); });
    $("#fExtra", alvo).addEventListener("change", (e) => { extra = e.target.value; desenhar(); });
    ligarSegmentos(alvo, "segBolsa", (k) => { bolsa = k; extra = ""; desenhar(); });
    ligarSegmentos(alvo, "segRk", (k) => { ranking = k; desenhar(); });
    $$("[data-extra]", alvo).forEach((tr) => tr.addEventListener("click", () => { extra = extra === tr.dataset.extra ? "" : tr.dataset.extra; desenhar(); }));

    const comDados = posicoes.filter((p) => mA.has(p) || mP.has(p));
    await graficoSafras($("#gSafra", alvo), {
      rotulos: comDados.map(rotuloPosicao),
      atual: comDados.map((p) => arred(mA.get(p)?.sacas ?? 0)),
      anterior: comDados.map((p) => arred(mP.get(p)?.sacas ?? 0)),
      rotAtual: safra, rotAnterior: `${ant ?? "Previous"}${periodo === "full crop" ? "" : ` (${periodo})`}`,
    });
  };
  await desenhar();
}

const fmtSinalDec = (v) => (v > 0 ? "+" : "") + fmtN(v, 2);

// Export Sales: volume embarcado, receita (US$), preço e diferencial em ¢/lb
function painelVendas(alvo, carga, ctx) {
  return painelSafras(alvo, ctx, {
    tipo: "vendas", titulo: "Export sales", rotVolume: "Shipped", rotValor: "Revenue", moeda: "$",
    rotPreco: "Avg final price · ¢/lb", rotDif: "Sale diff", unidadeDif: () => "¢/lb",
    notaMes: "Realized sales: month of the bill of lading (BL); crop from the contract. Crop year July to June.",
    dicaRanking: "Click a client to filter the page.",
    extra: { campo: "cliente", rotulo: "Client", todos: "All clients", valor: (r) => r._cliente },
    rankings: [["cliente", "Client", (r) => r._cliente], ["padrao", "Quality", (r) => r.padrao ?? "—"], ["grupo", "Quality group", (r) => r.grupo ?? "—"]],
    preparar(r) {
      const porTon = /TON/i.test(r.unidade ?? "");
      r._sacas = r.saida > 0 ? r.saida : (r.sacas ?? 0);
      r._preco = r.vlr_final == null ? null : porTon ? r.vlr_final * USDT_PARA_CLB : r.vlr_final;
      r._valor = r._preco != null ? (r._preco / 100) * r._sacas * LB_SACA : (r.valor_usd ?? 0);
      r._dif = r.diferencial == null ? null : porTon ? r.diferencial * USDT_PARA_CLB : r.diferencial;
      r._pos = posicaoSafra(r.data_bl, r.safra);
      r._cliente = clientePadronizado(r);
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
