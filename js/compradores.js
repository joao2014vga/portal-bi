// =====================================================================
// BUYER BIDS — a planilha "Base comprador - Negócios realizados"
// Cotações das tradings/exportadoras por qualidade e catação (aba "Base
// Comprador SAFRA NOVA": Data, Empresa e, para cada qualidade, o preço e o
// "Diff …") e os negócios fechados (aba "Negócios Realizados": Data, Empresa,
// Quantidade de Sacas e os mesmos pares preço/Diff).
//
// A planilha é lida no navegador e cada envio vira uma carga em
// bi_compradores_cargas (seção 31 do supabase/schema.sql). Ver: quem tem o
// card portal:compradores. Enviar: o admin e quem ele liberou (seção 32).
//
// As qualidades vêm do cabeçalho: toda coluna "Diff X" é uma qualidade e o
// preço é a coluna à esquerda. Qualidade nova na planilha aparece sozinha.
// =====================================================================
import { esc, $, $$, icon, toast, modal, confirmar, storage, tempoRelativo } from "./ui.js";
import { carregarXlsx } from "./position.js";
import { LOCALE, t } from "./i18n.js";

export const ehPainelCompradores = (link) => /^portal:compradores$/.test(link ?? "");

const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm";
const CHAVE_FILTROS = "portalbi_compradores_filtros";

// =====================================================================
// LEITURA DA PLANILHA (sem tela: dá para testar à parte)
// =====================================================================
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

// "FUTURO" → "Futuro", "RIO" → "Rio"; siglas curtas e códigos ficam ("SW", "GC 20%", "CD")
const rotulo = (s) => String(s).replace(/\s+/g, " ").trim().replace(/\b([A-ZÀ-Ú]{3,})\b/g, (p) => p[0] + p.slice(1).toLowerCase());

function numero(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, "");
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const isoDeDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function dataIso(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : isoDeDate(v);
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null; // não é data do Excel
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  }
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const i = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return i ? `${i[1]}-${i[2]}-${i[3]}` : null;
}

// Lê uma aba no formato Data | Empresa | [Sacas] | preço | Diff … ; devolve { qualidades, linhas }
function lerAba(XLSX, ws, comSacas) {
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const iCab = g.slice(0, 15).findIndex((l) => l?.some((c) => norm(c) === "DATA") && l.some((c) => norm(c) === "EMPRESA"));
  if (iCab < 0) return null;
  const cab = g[iCab].map((c) => String(c ?? "").trim());
  const iData = cab.findIndex((c) => norm(c) === "DATA");
  const iEmp = cab.findIndex((c) => norm(c) === "EMPRESA");
  const iSacas = cab.findIndex((c) => /SACAS/.test(norm(c)));
  const pares = [];
  cab.forEach((c, j) => {
    const m = c.match(/^diff\s+(.+)$/i);
    if (!m) return;
    const nome = rotulo(m[1]);
    const k = norm(nome);
    if (pares.some((p) => p.k === k)) return;
    const ip = j - 1;
    const precoOk = ip >= 0 && ip !== iData && ip !== iEmp && ip !== iSacas && !/^DIFF /.test(norm(cab[ip]));
    pares.push({ k, nome, iDif: j, iPreco: precoOk ? ip : -1 });
  });
  const linhas = [];
  for (const l of g.slice(iCab + 1)) {
    if (!l) continue;
    const d = dataIso(l[iData]);
    const e = norm(l[iEmp]);
    if (!d || !e) continue;
    const q = {};
    for (const p of pares) {
      const dif = numero(l[p.iDif]);
      if (dif == null) continue;
      q[p.k] = [p.iPreco >= 0 ? numero(l[p.iPreco]) : null, Math.round(dif * 100) / 100];
    }
    if (!Object.keys(q).length) continue;
    const r = { d, e, q };
    if (comSacas && iSacas >= 0) { const s = numero(l[iSacas]); if (s != null) r.s = s; }
    linhas.push(r);
  }
  return { qualidades: pares.filter((p) => linhas.some((r) => r.q[p.k])).map(({ k, nome }) => ({ k, nome })), linhas };
}

// "COFFEEBE" e "COFFEE BE" são o mesmo comprador: fica a grafia mais usada (empate: a com espaço)
function unificarNomes(...listas) {
  const cont = new Map();
  for (const r of listas.flat()) cont.set(r.e, (cont.get(r.e) ?? 0) + 1);
  const melhor = new Map();
  for (const [nome, n] of cont) {
    const k = nome.replace(/\s/g, "");
    const a = melhor.get(k);
    if (!a || n > cont.get(a) || (n === cont.get(a) && nome.length > a.length)) melhor.set(k, nome);
  }
  for (const r of listas.flat()) r.e = melhor.get(r.e.replace(/\s/g, ""));
}

export function lerPlanilhaCompradores(XLSX, wb) {
  const aba = (re) => wb.SheetNames.find((n) => re.test(norm(n)));
  const nBase = aba(/BASE/) ?? aba(/COMPRADOR/);
  const nNeg = aba(/NEGOCIO/);
  const base = nBase ? lerAba(XLSX, wb.Sheets[nBase], false) : null;
  if (!base) throw new Error("The spreadsheet has no buyer base sheet (with the Data and Empresa columns).");
  if (!base.linhas.length) throw new Error("No quotes found in the buyer base sheet.");
  const neg = (nNeg && lerAba(XLSX, wb.Sheets[nNeg], true)) || { qualidades: [], linhas: [] };
  unificarNomes(base.linhas, neg.linhas);
  const ord = (a, b) => a.d.localeCompare(b.d);
  return {
    qualidades: base.qualidades, qualidades_neg: neg.qualidades,
    base: base.linhas.sort(ord), negocios: neg.linhas.sort(ord),
  };
}

// =====================================================================
// QUALIDADES: grupo e cor (a cor segue a qualidade, nunca a posição)
// =====================================================================
const INFERIOR = /2RD|7\/2\/1|RIO/;
const COR_FIXA = { SW: 7, "FC 15%": 1, "GC 20%": 2, "GC 25%": 3, "GC 30%": 4, "GC 35%": 5, "GC 40%": 6, FUTURO: 8, "GC 2RD": 1, "GC 7/2/1": 2, RIO: 3 };
const PADRAO_VISIVEIS = ["FC 15%", "GC 20%", "GC 25%", "GC 30%", "FUTURO"];

function montarQualidades(lista) {
  const out = lista.map((q) => ({ ...q, grupo: INFERIOR.test(q.k) ? "inf" : "fina", cor: COR_FIXA[q.k] ?? null }));
  for (const grupo of ["fina", "inf"]) {
    const usadas = new Set(out.filter((q) => q.grupo === grupo && q.cor).map((q) => q.cor));
    for (const q of out.filter((x) => x.grupo === grupo && !x.cor)) {
      q.cor = [1, 2, 3, 4, 5, 6, 7, 8].find((c) => !usadas.has(c)) ?? null; // mais de 8: fica sem linha no gráfico
      if (q.cor) usadas.add(q.cor);
    }
  }
  return out;
}

// =====================================================================
// FORMATOS
// =====================================================================
const fmt = (n, c = 2) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString(LOCALE, { minimumFractionDigits: c, maximumFractionDigits: c }));
const fmtD = (n, c = 2) => (n == null || isNaN(n) ? "—" : Math.abs(n) < 0.005 ? fmt(0, c) : (n > 0 ? "+" : "") + fmt(n, c));
const fmtInt = (n) => Number(n ?? 0).toLocaleString(LOCALE);
const diaMes = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit" });
const dataLonga = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(LOCALE, { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "").replace(/ de /g, " ");
const somarDias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const nomeComprador = (s) => String(s).toLowerCase().replace(/(^|[\s/-])\S/g, (c) => c.toUpperCase())
  .replace(/\b(Ldc|Tpj|Ofi|Eisa|C6|Brc|Sa|Ltda)\b/g, (p) => p.toUpperCase());

// =====================================================================
// GRÁFICOS
// =====================================================================
let chartPromise;
const carregarChart = () => (chartPromise ??= import(CHART_URL).then((m) => { m.Chart.register(...m.registerables); return m.Chart; })
  .catch((e) => { chartPromise = null; throw e; }));

// linha vertical no ponto sob o mouse e marca do dia escolhido
const guia = {
  id: "bcGuia",
  afterDatasetsDraw(c, _a, o) {
    const g = c.ctx, { top, bottom } = c.chartArea;
    const linha = (x, cor, tracejado) => { g.save(); g.strokeStyle = cor; g.lineWidth = 1; g.setLineDash(tracejado ? [3, 3] : []); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore(); };
    if (o.marca != null && o.marca >= 0) linha(c.scales.x.getPixelForValue(o.marca), o.corMarca, false);
    const a = c.tooltip?.getActiveElements?.();
    if (a?.length) linha(a[0].element.x, o.cor, true);
  },
};

// =====================================================================
// TELA
// =====================================================================
export async function renderCompradores(link, alvo, ctx) {
  const api = ctx.api;
  let carga = null, Q = [], QN = [], BASE = [], NEG = [], ULTIMA = "", PRIMEIRA = "", DATAS = [];
  let salvos = {};
  try { salvos = JSON.parse(storage.get(CHAVE_FILTROS) ?? "{}") ?? {}; } catch { /* filtro salvo inválido */ }
  const st = { modo: ["dia", "7", "30", "90", "0"].includes(salvos.modo) ? salvos.modo : "90", dia: "", comp: "", rankQ: "", aba: "ultima", busca: "", pag: 0 };
  const vis = { fina: new Set(), inf: new Set() };
  const graficos = {};
  const temaEscuro = matchMedia("(prefers-color-scheme: dark)");
  // enviar a planilha: o admin e quem ele liberou (seção 32 do schema.sql); o banco confere de novo no envio
  let podeEnviar = !!ctx.admin;

  const carregar = async () => {
    alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading buyer bids…</div>`;
    try {
      [carga, podeEnviar] = await Promise.all([
        api.compradores(),
        ctx.admin ? true : api.podeEnviarCompradores().catch(() => false),
      ]);
    } catch (e) {
      alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Buyer bids are not available</h3><p>${esc(e.message)}</p></div>`;
      return;
    }
    if (!carga?.dados?.base?.length) { semDados(); return; }
    preparar();
    desenhar();
  };

  function preparar() {
    const d = carga.dados;
    BASE = d.base; NEG = d.negocios ?? [];
    Q = montarQualidades(d.qualidades ?? []);
    QN = d.qualidades_neg ?? [];
    DATAS = [...new Set(BASE.map((r) => r.d))].sort();
    PRIMEIRA = DATAS[0]; ULTIMA = DATAS.at(-1);
    st.dia = ULTIMA;
    const fina = Q.filter((q) => q.grupo === "fina" && q.cor);
    const pad = fina.filter((q) => PADRAO_VISIVEIS.includes(q.k));
    vis.fina = new Set((pad.length ? pad : fina.slice(0, 4)).map((q) => q.k));
    vis.inf = new Set(Q.filter((q) => q.grupo === "inf" && q.cor).map((q) => q.k));
    if (!Q.some((q) => q.k === st.rankQ)) st.rankQ = (Q.find((q) => q.k === "GC 20%") ?? Q[0])?.k ?? "";
  }

  function semDados() {
    alvo.innerHTML = `<div class="vazio">${icon("upload")}<h3>No buyer bids yet</h3>
      <p>${podeEnviar ? "Upload the “Base comprador – Negócios realizados” spreadsheet to publish the bids." : "The bids will appear here once the spreadsheet is uploaded."}</p>
      ${podeEnviar ? `<button class="btn btn-primary" id="bcEnviar">${icon("upload")}<span>Upload spreadsheet</span></button>` : ""}</div>`;
    $("#bcEnviar", alvo)?.addEventListener("click", enviar);
  }

  // ---------------------------------------------------------------- período
  // dia: só o dia escolhido; senão os N dias até a última base (0 = safra toda)
  const intervalo = () => {
    if (st.modo === "dia") return [st.dia, st.dia];
    const n = Number(st.modo);
    return [n ? somarDias(ULTIMA, -n + 1) : "0000", ULTIMA];
  };
  // os gráficos de linha precisam de mais de um dia: no modo dia mostram os 30 dias até ele, com o dia marcado
  const intervaloGrafico = () => (st.modo === "dia" ? [somarDias(st.dia, -29), st.dia] : intervalo());
  const noIntervalo = ([a, b]) => (r) => r.d >= a && r.d <= b;
  const doComprador = (r) => !st.comp || r.e === st.comp;
  const basePer = () => BASE.filter(noIntervalo(intervalo())).filter(doComprador);
  const negPer = () => NEG.filter(noIntervalo(intervalo())).filter(doComprador);
  const guardar = () => storage.set(CHAVE_FILTROS, JSON.stringify({ modo: st.modo }));

  // ---------------------------------------------------------------- desenho
  function desenhar() {
    const compradores = [...new Set([...BASE, ...NEG].map((r) => r.e))].sort((a, b) => a.localeCompare(b, LOCALE));
    if (st.comp && !compradores.includes(st.comp)) st.comp = "";
    const quando = carga.enviado_em ? tempoRelativo(carga.enviado_em) : "";
    const MODOS = [["dia", "Day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["0", "Whole crop"]];
    alvo.innerHTML = `<div class="pos bc">
      <div class="pos-topo">
        <div class="pos-data">${icon("clock")}<span>Bids up to <strong data-sem-traducao>${esc(dataLonga(ULTIMA))}</strong></span>
          <span class="muted">· ${esc(carga.nome_arquivo ?? "")}${carga.enviado_por ? ` · ${esc(t("sent by {n}", { n: carga.enviado_por }))}` : ""}${quando ? ` · ${esc(quando)}` : ""}</span></div>
        <div class="pos-acoes">
          ${podeEnviar ? `<button class="btn" id="bcEnviar" title="Read the spreadsheet and update the bids for everyone with access">${icon("upload")}<span>Upload spreadsheet</span></button>` : ""}
        </div>
      </div>

      <div class="pos-filtros qa-filtros bc-filtros">
        <label class="qa-fil"><span>Period</span>
          <span class="seg" id="bcModo" role="group" aria-label="Period">${MODOS.map(([v, r]) => `<button type="button" data-v="${v}" class="${st.modo === v ? "on" : ""}">${r}</button>`).join("")}</span>
        </label>
        <label class="qa-fil bc-dia ${st.modo === "dia" ? "" : "oculto"}"><span>Day</span>
          <span class="bc-dia-ctl">
            <button type="button" class="btn-icon" id="bcAnt" title="Previous day with bids" aria-label="Previous day with bids">‹</button>
            <input type="date" id="bcData" value="${st.dia}" min="${PRIMEIRA}" max="${ULTIMA}" aria-label="Day">
            <button type="button" class="btn-icon" id="bcProx" title="Next day with bids" aria-label="Next day with bids">›</button>
          </span>
        </label>
        <label class="qa-fil"><span>Buyer</span>
          <select id="bcComp"><option value="">All</option>${compradores.map((c) => `<option value="${esc(c)}" ${st.comp === c ? "selected" : ""}>${esc(nomeComprador(c))}</option>`).join("")}</select>
        </label>
        <span class="bc-faixa muted" id="bcFaixa"></span>
      </div>

      <div class="pos-kpis bc-kpis" id="bcKpis"></div>

      <section class="pos-card">
        <div class="pos-card-h pos-card-h-linha">
          <div><h2>Average diff by quality</h2>
            <p class="muted" id="bcDescLinha"></p></div>
          <div class="bc-chips" id="bcLegFina"></div>
        </div>
        <div class="bc-grafico"><canvas id="bcGFina" aria-label="Average diff by quality over time"></canvas></div>
        <p class="bc-nota">Diff in ¢/lb over NY. Days without a bid for a quality have no point (the line joins the neighbouring days).</p>
      </section>

      <div class="bc-grid bc-grid-73">
        <section class="pos-card">
          <div class="pos-card-h pos-card-h-linha">
            <div><h2>Who pays best</h2><p class="muted">Average diff of each buyer in the period, with the range from the worst to the best bid.</p></div>
            <select id="bcQualRank" aria-label="Quality">${Q.map((q) => `<option value="${esc(q.k)}" ${q.k === st.rankQ ? "selected" : ""}>${esc(q.nome)}</option>`).join("")}</select>
          </div>
          <div class="bc-rank" id="bcRank"></div>
          <div class="bc-leg-mini"><span><i class="d"></i>Average diff</span><span><i class="l"></i>Range (worst → best bid)</span><span><i class="r"></i>Market average</span><span>n = number of bids</span></div>
        </section>
        <section class="pos-card">
          <div class="pos-card-h"><h2>Lower grades</h2>
            <p class="muted">GC 2RD, GC 7/2/1 and Rio have their own chart: the discount is much larger and would flatten the other lines.</p></div>
          <div class="bc-chips" id="bcLegInf"></div>
          <div class="bc-grafico bc-baixo"><canvas id="bcGInf" aria-label="Average diff of the lower grades"></canvas></div>
        </section>
      </div>

      <section class="pos-card">
        <div class="pos-card-h pos-card-h-linha">
          <div><h2>Buyer × quality</h2><p class="muted">Average diff in the period. The colour compares the buyers within each column: darker = pays better for that quality.</p></div>
          <div class="bc-escala" aria-hidden="true"><span>worse</span><i style="background:var(--bc-q1)"></i><i style="background:var(--bc-q2)"></i><i style="background:var(--bc-q3)"></i><i style="background:var(--bc-q4)"></i><i style="background:var(--bc-q5)"></i><span>better</span></div>
        </div>
        <div class="bc-rolagem"><table class="tabela tabela-num bc-mapa" id="bcMapa"></table></div>
      </section>

      <section class="pos-card">
        <div class="bc-abas" role="tablist">
          <button type="button" data-aba="ultima" class="${st.aba === "ultima" ? "on" : ""}">Latest bid per buyer</button>
          <button type="button" data-aba="todas" class="${st.aba === "todas" ? "on" : ""}">All bids</button>
        </div>
        <div class="pos-card-h-linha">
          <p class="muted bc-desc" id="bcTabDesc"></p>
          <label class="busca sm">${icon("search")}<input type="search" id="bcBusca" placeholder="Search buyer" value="${esc(st.busca)}" aria-label="Search buyer"></label>
        </div>
        <div class="bc-rolagem"><table class="tabela tabela-num bc-tab" id="bcTab"></table></div>
        <div class="bc-pag" id="bcPag"></div>
      </section>

      <div class="bc-secao">Deals closed</div>
      <div class="bc-grid">
        <section class="pos-card">
          <div class="pos-card-h"><h2>Bags traded by buyer</h2><p class="muted">Sum of the bags of the deals closed in the period.</p></div>
          <div class="bc-barras" id="bcBarras"></div>
        </section>
        <section class="pos-card">
          <div class="pos-card-h"><h2>Average diff traded by quality</h2><p class="muted">Weighted by bags.</p></div>
          <div class="bc-rolagem"><table class="tabela tabela-num" id="bcNegQual"></table></div>
        </section>
      </div>
      <section class="pos-card">
        <div class="pos-card-h"><h2>Deals in the period</h2><p class="muted" id="bcNegDesc"></p></div>
        <div class="bc-rolagem"><table class="tabela tabela-num" id="bcNegTab"></table></div>
      </section>
    </div>`;

    $("#bcEnviar", alvo)?.addEventListener("click", enviar);
    $$("#bcModo button", alvo).forEach((b) => b.addEventListener("click", () => {
      st.modo = b.dataset.v; st.pag = 0; guardar();
      $$("#bcModo button", alvo).forEach((x) => x.classList.toggle("on", x === b));
      $(".bc-dia", alvo).classList.toggle("oculto", st.modo !== "dia");
      atualizar();
    }));
    $("#bcData", alvo).addEventListener("change", (e) => { if (e.target.value) { st.dia = e.target.value; st.pag = 0; atualizar(); } });
    const pular = (dir) => {
      const i = dir < 0 ? DATAS.findLastIndex((d) => d < st.dia) : DATAS.findIndex((d) => d > st.dia);
      if (i < 0) return;
      st.dia = DATAS[i]; $("#bcData", alvo).value = st.dia; st.pag = 0; atualizar();
    };
    $("#bcAnt", alvo).addEventListener("click", () => pular(-1));
    $("#bcProx", alvo).addEventListener("click", () => pular(1));
    $("#bcComp", alvo).addEventListener("change", (e) => { st.comp = e.target.value; st.pag = 0; atualizar(); });
    $("#bcQualRank", alvo).addEventListener("change", (e) => { st.rankQ = e.target.value; desenharRank(); });
    $$(".bc-abas button", alvo).forEach((b) => b.addEventListener("click", () => {
      $$(".bc-abas button", alvo).forEach((x) => x.classList.toggle("on", x === b));
      st.aba = b.dataset.aba; st.pag = 0; desenharTabela();
    }));
    let tmp;
    $("#bcBusca", alvo).addEventListener("input", (e) => { clearTimeout(tmp); tmp = setTimeout(() => { st.busca = norm(e.target.value); st.pag = 0; desenharTabela(); }, 200); });
    atualizar();
  }

  function atualizar() {
    const [a, b] = intervalo();
    $("#bcFaixa", alvo).textContent = st.modo === "dia"
      ? t("Bids of {d}", { d: dataLonga(st.dia) })
      : t("{a} to {b}", { a: dataLonga(a === "0000" ? PRIMEIRA : a < PRIMEIRA ? PRIMEIRA : a), b: dataLonga(b) });
    $("#bcDescLinha", alvo).textContent = st.modo === "dia"
      ? t("Average of all bids of each day, per quality, in the 30 days up to {d} (marked line). The higher the line, the better buyers are paying. Click the legend to show or hide a quality.", { d: diaMes(st.dia) })
      : t("Average of all bids of each day, per quality. The higher the line, the better buyers are paying. Click the legend to show or hide a quality.");
    desenharKpis();
    desenharLinha("fina", "#bcGFina", "#bcLegFina");
    desenharLinha("inf", "#bcGInf", "#bcLegInf");
    desenharRank(); desenharMapa(); desenharTabela(); desenharNegocios();
  }

  // ---------------------------------------------------------------- KPIs
  function desenharKpis() {
    const b = basePer(), n = negPer();
    const fim = intervalo()[1];
    const qk = (Q.find((q) => q.k === "GC 20%") ?? Q.find((q) => q.grupo === "fina") ?? Q[0]).k;
    const qn = Q.find((q) => q.k === qk).nome;
    const difs = (rs) => rs.filter((r) => r.q[qk]).map((r) => r.q[qk][1]);
    const doDia = media(difs(BASE.filter((r) => r.d === fim).filter(doComprador)));
    // comparação: no modo dia, os 30 dias antes dele; senão, o período todo
    const ref = st.modo === "dia"
      ? media(difs(BASE.filter(noIntervalo([somarDias(fim, -30), somarDias(fim, -1)])).filter(doComprador)))
      : media(difs(b));
    const dlt = doDia != null && ref != null ? doDia - ref : null;
    const ultDia = BASE.filter((r) => r.d === ULTIMA).filter(doComprador);
    const sacas = n.reduce((s, r) => s + (r.s || 0), 0);
    const kpi = (tit, val, sub) => `<div class="pos-kpi pos-kpi-est"><div class="pos-kpi-t">${tit}</div><div class="pos-kpi-v">${val}</div><div class="pos-kpi-s">${sub}</div></div>`;
    $("#bcKpis", alvo).innerHTML =
      kpi("Latest bids", `<span data-sem-traducao>${esc(dataLonga(ULTIMA))}</span>`, esc(t("{n} bids that day", { n: fmtInt(ultDia.length) })))
      + kpi(st.modo === "dia" ? "Bids on the day" : "Bids in the period", fmtInt(b.length), esc(t("from {n} buyers", { n: fmtInt(new Set(b.map((r) => r.e)).size) })))
      + kpi(esc(t("{q} diff · {d}", { q: qn, d: diaMes(fim) })), `${fmtD(doDia)}<small class="bc-un">¢/lb</small>`,
        doDia == null ? esc(t("No {q} bid on this day", { q: qn }))
          : `${esc(t(st.modo === "dia" ? "previous 30 days {v}" : "period average {v}", { v: fmtD(ref) }))}${dlt == null ? "" : ` · <span class="bc-delta ${dlt >= 0 ? "up" : "down"}">${dlt >= 0 ? "▲" : "▼"} ${fmt(Math.abs(dlt))}</span>`}`)
      + kpi("Bags traded", `${fmtInt(sacas)}<small class="bc-un">bags</small>`, esc(t(st.modo === "dia" ? "{n} deals on the day" : "{n} deals in the period", { n: fmtInt(n.length) })));
  }

  // ---------------------------------------------------------------- gráficos de linha
  function cor(v) { return getComputedStyle(alvo.querySelector(".bc") ?? alvo).getPropertyValue(v).trim(); }

  async function desenharLinha(grupo, idCanvas, idLeg) {
    const [a, b] = intervaloGrafico();
    const rs = BASE.filter(noIntervalo([a, b])).filter(doComprador);
    const qs = Q.filter((q) => q.grupo === grupo && q.cor && rs.some((r) => r.q[q.k]));
    const leg = $(idLeg, alvo), canvas = $(idCanvas, alvo);
    graficos[idCanvas]?.destroy(); delete graficos[idCanvas];
    if (!qs.length) {
      leg.innerHTML = "";
      canvas.parentElement.classList.add("bc-sem");
      canvas.parentElement.dataset.msg = t(grupo === "inf" ? "No lower-grade bids in this period." : "No bids in this period.");
      return;
    }
    canvas.parentElement.classList.remove("bc-sem");
    const dias = [...new Set(rs.filter((r) => qs.some((q) => r.q[q.k])).map((r) => r.d))].sort();
    const set = vis[grupo];
    leg.innerHTML = qs.map((q) => `<button type="button" class="bc-chip ${set.has(q.k) ? "" : "off"}" data-k="${esc(q.k)}" style="--c:var(--bc-s${q.cor})" aria-pressed="${set.has(q.k)}"><i></i>${esc(q.nome)}</button>`).join("");
    $$(".bc-chip", leg).forEach((ch) => ch.addEventListener("click", () => {
      const k = ch.dataset.k;
      set.has(k) ? set.delete(k) : set.add(k);
      ch.classList.toggle("off", !set.has(k)); ch.setAttribute("aria-pressed", set.has(k));
      const g = graficos[idCanvas]; if (!g) return;
      const ds = g.data.datasets.find((x) => x.k === k); if (ds) { ds.hidden = !set.has(k); g.update(); }
    }));
    let Chart;
    try { Chart = await carregarChart(); } catch {
      canvas.parentElement.classList.add("bc-sem");
      canvas.parentElement.dataset.msg = t("Chart unavailable. Check your connection.");
      return;
    }
    if (!document.body.contains(canvas)) return; // a tela mudou enquanto o Chart.js carregava
    graficos[idCanvas]?.destroy();
    const tinta = cor("--texto-2"), grade = cor("--bc-grade"), sup = cor("--sup");
    const datasets = qs.map((q) => {
      const c = cor(`--bc-s${q.cor}`);
      return {
        label: q.nome, k: q.k, borderColor: c, backgroundColor: c, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
        pointBorderColor: sup, pointBorderWidth: 1, spanGaps: true, tension: 0.25, hidden: !set.has(q.k),
        data: dias.map((d) => { const v = rs.filter((r) => r.d === d && r.q[q.k]).map((r) => r.q[q.k][1]); return v.length ? Math.round(media(v) * 100) / 100 : null; }),
      };
    });
    const fonte = { family: "Inter, system-ui, sans-serif", size: 11 };
    graficos[idCanvas] = new Chart(canvas, {
      type: "line",
      data: { labels: dias.map(diaMes), datasets },
      plugins: [guia],
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          bcGuia: { cor: cor("--texto-3"), corMarca: cor("--brand"), marca: st.modo === "dia" ? dias.indexOf(st.dia) : null },
          tooltip: {
            backgroundColor: sup, titleColor: cor("--texto"), bodyColor: cor("--texto"), borderColor: cor("--borda"), borderWidth: 1,
            padding: 10, boxPadding: 4, usePointStyle: true, itemSort: (x, y) => y.raw - x.raw, filter: (i) => i.raw != null,
            callbacks: { title: (i) => i[0].label, label: (i) => ` ${i.dataset.label}: ${fmtD(i.raw)} ¢/lb` },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: grade }, ticks: { color: tinta, font: fonte, maxRotation: 0, autoSkipPadding: 14 } },
          y: { grid: { color: grade }, border: { display: false }, ticks: { color: tinta, font: fonte, callback: (v) => fmtD(v, 0) },
            title: { display: true, text: t("Diff (¢/lb)"), color: tinta, font: fonte } },
        },
      },
    });
  }

  // ---------------------------------------------------------------- quem paga melhor
  // compara todos os compradores (o filtro de comprador só destaca o escolhido)
  function desenharRank() {
    const k = st.rankQ;
    const nome = Q.find((q) => q.k === k)?.nome ?? k;
    const rs = BASE.filter(noIntervalo(intervalo())).filter((r) => r.q[k]);
    const por = {};
    rs.forEach((r) => (por[r.e] ??= []).push(r.q[k][1]));
    const linhas = Object.entries(por).map(([e, v]) => ({ e, m: media(v), min: Math.min(...v), max: Math.max(...v), n: v.length })).sort((x, y) => y.m - x.m);
    const caixa = $("#bcRank", alvo);
    if (!linhas.length) { caixa.innerHTML = `<p class="bc-vazio">${esc(t("No {q} bids in this period.", { q: nome }))}</p>`; return; }
    const geral = media(rs.map((r) => r.q[k][1]));
    let lo = Math.min(...linhas.map((l) => l.min)), hi = Math.max(...linhas.map((l) => l.max));
    const pad = Math.max(1, (hi - lo) * 0.06); lo -= pad; hi += pad;
    const x = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
    caixa.innerHTML = `<div class="bc-rank-eixo"><span></span><span class="bc-esc"><span>${fmt(lo, 0)}</span><span>← worse · better →</span><span>${fmt(hi, 0)}</span></span><span>average</span><span>n</span></div>`
      + linhas.map((l) => `<div class="bc-rank-lin ${st.comp === l.e ? "sel" : ""}" title="${esc(t("{e}: average {m} · worst {min} · best {max} · {n} bids", { e: nomeComprador(l.e), m: fmtD(l.m), min: fmtD(l.min), max: fmtD(l.max), n: l.n }))}">
        <span class="nome">${esc(nomeComprador(l.e))}</span>
        <span class="trilho"><span class="ref" style="left:${x(geral)}"></span><span class="faixa" style="left:${x(l.min)};width:calc(${x(l.max)} - ${x(l.min)})"></span><span class="pt" style="left:${x(l.m)}"></span></span>
        <span class="v">${fmtD(l.m)}</span><span class="n">${l.n}</span></div>`).join("");
  }

  // ---------------------------------------------------------------- comprador × qualidade
  function desenharMapa() {
    const rs = BASE.filter(noIntervalo(intervalo()));
    const qs = Q.filter((q) => rs.some((r) => r.q[q.k]));
    const tab = $("#bcMapa", alvo);
    if (!qs.length) { tab.innerHTML = `<tbody><tr><td class="bc-vazio">${esc(t("No bids in this period."))}</td></tr></tbody>`; return; }
    const comps = [...new Set(rs.map((r) => r.e))];
    const nCot = Object.fromEntries(comps.map((e) => [e, rs.filter((r) => r.e === e).length]));
    comps.sort((a, b) => nCot[b] - nCot[a] || a.localeCompare(b, LOCALE));
    const m = {};
    comps.forEach((e) => { m[e] = {}; qs.forEach((q) => { m[e][q.k] = media(rs.filter((r) => r.e === e && r.q[q.k]).map((r) => r.q[q.k][1])); }); });
    const faixa = Object.fromEntries(qs.map((q) => { const v = comps.map((e) => m[e][q.k]).filter((y) => y != null); return [q.k, [Math.min(...v), Math.max(...v)]]; }));
    tab.innerHTML = `<thead><tr><th>Buyer</th>${qs.map((q) => `<th>${esc(q.nome)}</th>`).join("")}<th>Bids</th></tr></thead><tbody>`
      + comps.map((e) => `<tr class="${st.comp === e ? "linha-sel" : ""}"><td>${esc(nomeComprador(e))}</td>${qs.map((q) => {
        const v = m[e][q.k];
        if (v == null) return `<td class="bc-nada">·</td>`;
        const [lo, hi] = faixa[q.k];
        const passo = 1 + Math.min(4, Math.floor((hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 5));
        return `<td class="bc-cel ${passo >= 4 ? "esc" : ""}" style="background:var(--bc-q${passo})" title="${esc(`${nomeComprador(e)} · ${q.nome}: ${fmtD(v)} ¢/lb`)}">${fmtD(v)}</td>`;
      }).join("")}<td class="muted">${nCot[e]}</td></tr>`).join("") + "</tbody>";
  }

  // ---------------------------------------------------------------- tabela de cotações
  function desenharTabela() {
    let rs = basePer();
    if (st.busca) rs = rs.filter((r) => r.e.includes(st.busca));
    const fim = intervalo()[1];
    let linhas;
    if (st.aba === "ultima") {
      const ult = {};
      rs.forEach((r) => { if (!ult[r.e] || r.d >= ult[r.e].d) ult[r.e] = r; });
      linhas = Object.values(ult).sort((a, b) => b.d.localeCompare(a.d) || a.e.localeCompare(b.e, LOCALE));
      $("#bcTabDesc", alvo).textContent = t(st.modo === "dia"
        ? "The bids of the day. In green, the best diff of each column."
        : "The most recent bid of each buyer in the period. In green, the best diff of each column among the bids of the last 7 days; older bids are faded.");
    } else {
      linhas = [...rs].sort((a, b) => b.d.localeCompare(a.d) || a.e.localeCompare(b.e, LOCALE));
      $("#bcTabDesc", alvo).textContent = t("{n} bids in the period, most recent first.", { n: fmtInt(linhas.length) });
    }
    const recente = (r) => diasEntre(r.d, fim) <= 7;
    const qs = Q.filter((q) => linhas.some((r) => r.q[q.k]));
    const melhor = Object.fromEntries(qs.map((q) => [q.k, Math.max(...linhas.filter((r) => r.q[q.k] && recente(r)).map((r) => r.q[q.k][1]))]));
    const porPag = 25, tot = Math.max(1, Math.ceil(linhas.length / porPag));
    st.pag = Math.min(st.pag, tot - 1);
    const vis_ = st.aba === "todas" ? linhas.slice(st.pag * porPag, (st.pag + 1) * porPag) : linhas;
    const tab = $("#bcTab", alvo);
    if (!vis_.length) {
      tab.innerHTML = `<tbody><tr><td class="bc-vazio">${esc(t(st.busca ? "No buyer matches the search." : "No bids in this period."))}</td></tr></tbody>`;
      $("#bcPag", alvo).innerHTML = "";
      return;
    }
    tab.innerHTML = `<thead><tr><th>Date</th><th>Buyer</th>${qs.map((q) => `<th>${esc(q.nome)}</th>`).join("")}</tr></thead><tbody>`
      + vis_.map((r) => {
        const velha = st.aba === "ultima" && !recente(r);
        return `<tr class="${velha ? "bc-velha" : ""}"><td>${diaMes(r.d)}${velha ? `<span class="bc-p">${esc(t("{n} days ago", { n: diasEntre(r.d, fim) }))}</span>` : ""}</td><td>${esc(nomeComprador(r.e))}</td>${qs.map((q) => {
          const v = r.q[q.k];
          if (!v) return `<td class="bc-nada">·</td>`;
          const top = st.aba === "ultima" && !velha && v[1] === melhor[q.k];
          return `<td class="${top ? "bc-melhor" : ""}"><span class="bc-dif">${fmtD(v[1])}</span>${v[0] != null ? `<span class="bc-p">R$ ${fmt(v[0], 0)}</span>` : ""}</td>`;
        }).join("")}</tr>`;
      }).join("") + "</tbody>";
    const pag = $("#bcPag", alvo);
    pag.innerHTML = st.aba === "todas" && tot > 1
      ? `<span>${esc(t("Page {a} of {b}", { a: st.pag + 1, b: tot }))}</span><span><button type="button" class="btn btn-sm" id="bcPgA" ${st.pag === 0 ? "disabled" : ""}>‹ Previous</button> <button type="button" class="btn btn-sm" id="bcPgP" ${st.pag >= tot - 1 ? "disabled" : ""}>Next ›</button></span>`
      : `<span>Each cell: diff in ¢/lb (top) and price in R$/bag (bottom).</span>`;
    $("#bcPgA", alvo)?.addEventListener("click", () => { st.pag--; desenharTabela(); });
    $("#bcPgP", alvo)?.addEventListener("click", () => { st.pag++; desenharTabela(); });
  }

  // ---------------------------------------------------------------- negócios realizados
  function desenharNegocios() {
    const n = negPer();
    const nomeQN = (k) => QN.find((q) => q.k === k)?.nome ?? k;
    const por = {};
    n.forEach((r) => (por[r.e] = (por[r.e] || 0) + (r.s || 0)));
    const lin = Object.entries(por).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], LOCALE));
    const max = Math.max(1, ...lin.map((l) => l[1]));
    $("#bcBarras", alvo).innerHTML = lin.length
      ? lin.map(([e, s]) => (s
        ? `<div class="bc-barra" title="${esc(`${nomeComprador(e)}: ${fmtInt(s)}`)}"><span>${esc(nomeComprador(e))}</span><span class="t"><b style="width:${((s / max) * 100).toFixed(1)}%"></b></span><span class="v">${fmtInt(s)}</span></div>`
        : `<div class="bc-barra"><span>${esc(nomeComprador(e))}</span><span class="bc-sq">Quantity not filled in the spreadsheet</span><span class="v">—</span></div>`)).join("")
      : `<p class="bc-vazio">${esc(t("No deals in this period."))}</p>`;

    const qs = QN.filter((q) => n.some((r) => r.q[q.k]));
    $("#bcNegQual", alvo).innerHTML = `<thead><tr><th>Quality</th><th>Deals</th><th>Bags</th><th>Average price</th><th>Average diff</th></tr></thead><tbody>`
      + (qs.length ? qs.map((q) => {
        const rs = n.filter((r) => r.q[q.k]);
        const sc = rs.reduce((s, r) => s + (r.s || 0), 0);
        const pond = (i) => {
          const ok = rs.filter((r) => r.q[q.k][i] != null);
          const p = ok.reduce((s, r) => s + (r.s || 0), 0);
          return p ? ok.reduce((s, r) => s + r.q[q.k][i] * (r.s || 0), 0) / p : media(ok.map((r) => r.q[q.k][i]));
        };
        return `<tr><td>${esc(q.nome)}</td><td>${rs.length}</td><td>${fmtInt(sc)}</td><td>R$ ${fmt(pond(0), 0)}</td><td class="forte">${fmtD(pond(1))}</td></tr>`;
      }).join("") : `<tr><td colspan="5" class="bc-vazio">${esc(t("No deals in this period."))}</td></tr>`) + "</tbody>";

    const ord = [...n].sort((a, b) => b.d.localeCompare(a.d));
    $("#bcNegDesc", alvo).textContent = t("{a} deals · {b} bags", { a: fmtInt(ord.length), b: fmtInt(ord.reduce((s, r) => s + (r.s || 0), 0)) });
    $("#bcNegTab", alvo).innerHTML = `<thead><tr><th>Date</th><th>Buyer</th><th>Quality</th><th>Bags</th><th>Price (R$/bag)</th><th>Diff (¢/lb)</th></tr></thead><tbody>`
      + (ord.length ? ord.flatMap((r) => Object.entries(r.q).map(([k, v]) =>
        `<tr><td>${diaMes(r.d)}</td><td>${esc(nomeComprador(r.e))}</td><td>${esc(nomeQN(k))}</td><td>${r.s ? fmtInt(r.s) : '<span class="muted">—</span>'}</td><td>${fmt(v[0], 0)}</td><td class="forte">${fmtD(v[1])}</td></tr>`)).join("")
        : `<tr><td colspan="6" class="bc-vazio">${esc(t("No deals in this period."))}</td></tr>`) + "</tbody>";
  }

  // ---------------------------------------------------------------- envio da planilha (admin)
  function enviar() {
    modal({
      titulo: "Upload buyer bids",
      botao: "Read spreadsheet",
      corpo: `<p class="muted">Choose the “Base comprador – Negócios realizados” spreadsheet (.xlsx). It is read in your browser and the bids and deals are updated for everyone with access. The previous uploads are kept.</p>
        <label class="campo"><span>Spreadsheet *</span><input type="file" name="arquivo" accept=".xlsx,.xlsm" required></label>`,
      async onSubmit(f) {
        const file = f.arquivo.files[0];
        if (!file) throw new Error("Please choose the spreadsheet.");
        const XLSX = await carregarXlsx();
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellFormula: false, cellHTML: false, cellStyles: false });
        const dados = lerPlanilhaCompradores(XLSX, wb);
        // conferir antes de publicar (fecha este e abre a confirmação)
        setTimeout(() => confirmarEnvio(dados, file.name), 0);
      },
    });
  }

  async function confirmarEnvio(dados, nome) {
    const datas = dados.base.map((r) => r.d);
    const comps = new Set(dados.base.map((r) => r.e)).size;
    const antes = carga?.dados?.base?.length ?? 0;
    const ultAntes = carga?.dados?.base?.length ? carga.dados.base.at(-1).d : null;
    const ultNova = datas.at(-1);
    const avisos = [];
    if (antes && dados.base.length < antes) avisos.push(t("The spreadsheet has fewer bids ({a}) than what is published now ({b}). Check that it is the right file.", { a: fmtInt(dados.base.length), b: fmtInt(antes) }));
    if (ultAntes && ultNova < ultAntes) avisos.push(t("Its latest bid ({a}) is older than the one published now ({b}).", { a: dataLonga(ultNova), b: dataLonga(ultAntes) }));
    const ok = await confirmar("Publish buyer bids",
      esc(t("{a} bids from {b} buyers, from {c} to {d}, and {e} deals.", { a: fmtInt(dados.base.length), b: fmtInt(comps), c: dataLonga(datas[0]), d: dataLonga(ultNova), e: fmtInt(dados.negocios.length) }))
      + `<br><span class="muted">${esc(t("Qualities: {q}", { q: dados.qualidades.map((q) => q.nome).join(", ") }))}</span>`
      + avisos.map((a) => `<br><br><strong class="txt-alerta">${esc(a)}</strong>`).join(""),
      t("Publish"));
    if (!ok) return;
    try {
      await api.enviarCompradores(dados, nome);
      toast(t("Buyer bids updated: {n} bids.", { n: fmtInt(dados.base.length) }));
      ctx.recarregar?.() ?? carregar();
    } catch (e) { toast(e.message, "erro"); }
  }

  // tema claro/escuro mudou: redesenha os gráficos com as cores novas
  const aoTema = () => { if (document.body.contains(alvo) && $(".bc", alvo)) { desenharLinha("fina", "#bcGFina", "#bcLegFina"); desenharLinha("inf", "#bcGInf", "#bcLegInf"); } else temaEscuro.removeEventListener("change", aoTema); };
  temaEscuro.addEventListener("change", aoTema);

  await carregar();
}
