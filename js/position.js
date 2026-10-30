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
//   portal:position-commercial Dashboard Commercial (vendas de exportação; era um Power BI)
import { esc, $, $$, icon, toast, modal, tempoRelativo, dataBR, dataHoraBR } from "./ui.js";
import {
  ABAS, COLS_TERMM, norm, num, arred, montarPosition, extrairModelo, extrairFuturos, aplicarPtax,
  prazoFixacao, alertasFixacao, textoAlertaFixacao, CAMPO_MES, ALERTA_DIAS, AVISO_DIAS, pegadaPosition, alteracoesPosition,
  calcularPosition, basesDaGrade,
} from "./position-calc.js";
import { t as tr, LOCALE, IDIOMA } from "./i18n.js";

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm";

export const ehPainelPosition = (link) => /^portal:position-/.test(link ?? "");

// =====================================================================
// LEITURA DA PLANILHA (o cálculo e as regras ficam em position-calc.js)
// =====================================================================
let xlsxPromise;
export function carregarXlsx() {
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
  // composição da matriz da Posição Física: recalcula a própria planilha com as fórmulas dela
  // (mesmo resultado do Excel) para saber que linhas formam cada célula
  if (modelo) {
    try { detalhes.fisica_itens = calcularPosition(modelo, basesDaGrade(gAba), { hoje: data_ref }).detalhes.fisica_itens; }
    catch { /* segue sem a composição */ }
  }
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
// Padrão do portal: negativo entre parênteses, "(1.234)" — e em vermelho (marcarNegativos).
// `suf` entra dentro do parêntese: "(12%)", "(3,5k)".
export const fmtN = (v, dec = 0, suf = "") => {
  if (v == null) return "—";
  const txt = Math.abs(Number(v)).toLocaleString(LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  // -0,4 arredondado para 0 não é negativo
  return Number(v) < 0 && /[1-9]/.test(txt) ? `(${txt}${suf})` : `${txt}${suf}`;
};
const fmtSinal = (v) => (v > 0 ? "+" : "") + fmtN(v);

// Pinta de vermelho os números negativos "(…)" de células, indicadores e variações.
// Roda sozinho a cada redesenho do painel (MutationObserver em renderPosition).
const RE_NEG = /^[▲▼]?\s*\([^()]*\d[^()]*\)$/;
function marcarNegativos(raiz) {
  for (const el of raiz.querySelectorAll("td, th, .pos-kpi-v, .pos-kpi-s span, .pos-kpi-d b, .yoy, .cel-barra b, .pos-alt-ef")) {
    if (el.children.length && !el.matches(".yoy")) continue;
    el.classList.toggle("neg", RE_NEG.test(el.textContent.trim()));
  }
}
export function vigiarNegativos(alvo) {
  if (alvo._vigiaNeg) return;
  let quadro = 0;
  alvo._vigiaNeg = new MutationObserver(() => { cancelAnimationFrame(quadro); quadro = requestAnimationFrame(() => marcarNegativos(alvo)); });
  alvo._vigiaNeg.observe(alvo, { childList: true, subtree: true, characterData: true });
}
// mês curto: "Dec-26" em inglês, "Dez/26" em português
const MESES_CURTOS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtMes = (iso) => (iso ? `${tr(MESES_CURTOS[Number(iso.slice(5, 7)) - 1])}${IDIOMA === "pt" ? "/" : "-"}${iso.slice(2, 4)}` : "—");
export const fmtData = (iso) => (iso ? dataBR(iso + "T12:00:00") : "—");
const fmtK = (v) => (Math.abs(v) >= 1000 ? fmtN(v / 1000, Math.abs(v) >= 10000 ? 0 : 1, "k") : fmtN(v));

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
export function segmentos(id, opcoes, atual) {
  return `<div class="seg" role="tablist" id="${id}">${opcoes.map(([k, t]) =>
    `<button type="button" role="tab" data-k="${k}" class="${k === atual ? "on" : ""}" aria-selected="${k === atual}">${esc(t)}</button>`).join("")}</div>`;
}
export function ligarSegmentos(raiz, id, ao) {
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
  vigiarNegativos(alvo);
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
    "portal:position-commercial": painelComercial,
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
      <button class="btn" id="posFuturo" title="Paste the broker confirmation e-mail">${icon("plus")}<span>New futures trade</span></button>
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
  $("#posFuturo", alvo)?.addEventListener("click", () => novaOperacaoFuturos(ctx));
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
        await ctx.api.salvarPositionModelo({ ...modelo, futuros: manterFuturosDoPortal(lida.futuros, modelo.futuros) }, file.name);
        toast(`Futures updated: ${fmtN(lida.futuros.length)} trades. Recalculating from Digisul…`);
        await ctx.api.sincronizarPosition().then(() => toast("Position updated from Digisul.")).catch((e) => toast(e.message, "erro"));
        ctx.recarregar();
        return;
      }
      // o que mudou contra a última planilha de um dia anterior
      lida.resumo.pegada = pegadaPosition(lida.detalhes);
      const [anterior, ultima] = await Promise.all([
        ctx.api.positionPegadaAnterior?.("planilha", lida.data_ref).catch(() => null),
        ctx.api.positionPegadaAnterior?.("planilha").catch(() => null),
      ]);
      lida.resumo.alteracoes = anterior ? alteracoesPosition(lida.resumo.pegada, anterior.pegada, anterior.data_ref) : null;
      lida.resumo.alteracoes_ultima = ultima ? alteracoesPosition(lida.resumo.pegada, ultima.pegada, ultima.created_at) : null;
      // contratos vencidos ou a vencer em 15 dias viram notificação para quem vê o Open Contracts
      await ctx.api.publicarPosition({ data_ref: lida.data_ref, resumo: lida.resumo, detalhes: lida.detalhes, nome_arquivo: file.name, alerta: textoAlertaFixacao(lida.detalhes, fmtN) });
      toast(`Position of ${fmtData(lida.data_ref)} published.`);
      lida.avisos.forEach((a) => toast(a, "erro"));
      // fórmulas e futuros desta planilha passam a valer para a atualização pelo Digisul
      if (lida.modelo) {
        try {
          const antigos = await ctx.api.positionFuturos?.().catch(() => null);
          lida.modelo.futuros = manterFuturosDoPortal(lida.modelo.futuros, antigos);
          await ctx.api.salvarPositionModelo(lida.modelo, file.name);
          ctx.api.sincronizarPosition().catch(() => { /* o agendamento tenta de novo */ });
        } catch (e) { toast(e.message, "erro"); }
      }
      ctx.recarregar();
    },
  }));
}

// ---------------------------------------------------------------- Nova operação de futuros
// Cola o e-mail de confirmação da corretora (ex.: Marex); o portal preenche as colunas
// A–L da OpenFutures, a pessoa completa Notas, Book e Alloc, e a operação entra nos
// futuros que a atualização pelo Digisul usa. Fica marcada com "_portal" (a data em que
// entrou), para poder ser desfeita e para não sumir quando a planilha for enviada.
const MESES_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const serialDeIso = (iso) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 864e5);
const isoDeSerial = (n) => (typeof n === "number" ? new Date(Date.UTC(1899, 11, 30) + n * 864e5).toISOString().slice(0, 10) : null);
const numEmail = (s) => (s == null ? null : Number(String(s).replace(/,/g, "")));  // formato americano: 3,385.00

export function lerEmailFuturos(texto, futuros = []) {
  const t = String(texto ?? "").replace(/ /g, " ");
  // os valores vêm depois dos títulos da tabela (o último é "Expiry Date")
  const dados = t.split(/Expiry\s*Date/i).slice(1).join(" ") || t;
  const ref = /Reference\s*(?:Number|No\.?)\s*:?\s*([A-Z0-9]+-\d+)/i.exec(t)?.[1] ?? null;
  const lado = /(?:^|[\s|;])(Buy|Sell)(?![\w/])/i.exec(dados)?.[1] ?? null;
  const bolsa = /Robusta|London|\bLRC\b|\bRC\b/i.test(dados) ? "LONDRES" : /Coffee\s*['’"]?C\b|Arabica|\bKC\b/i.test(dados) ? "NY" : null;
  // mês de entrega: mês e ano sem dia na frente (a data de vencimento vem com o dia)
  const mes = /(?<!\d\s)\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(20\d\d)\b/i.exec(dados);
  const strike = /([\d.,]+)\s*(USc\s*\/\s*Lb|US\s*cents?|USD\s*\/\s*M?T|\$\s*\/\s*M?T|BRL)/i.exec(dados);
  const lotes = /([\d.,]+)\s*lots?\b/i.exec(dados);
  const agente = /Calculation\s*Agent\s*:?\s*([A-Za-z]+)/i.exec(t)?.[1] ?? null;
  const prefixo = ref?.split("-")[0];
  // corretora: a mesma das operações já lançadas com essa conta; senão "conta AGENTE"
  const corretora = (prefixo && futuros.find((f) => String(f["Trade No."] ?? "").startsWith(`${prefixo}-`))?.Corretora)
    || (prefixo && agente ? `${prefixo} ${agente.toUpperCase()}` : null);
  return {
    trade: ref,
    tipo: lado ? (/sell/i.test(lado) ? "Venda" : "Compra") : null,
    bolsa,
    mes: mes ? `${mes[2]}-${String(MESES_EN.indexOf(mes[1].slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}` : null,
    valor: strike ? numEmail(strike[1]) : null,
    currency: strike ? (/BRL/i.test(strike[2]) ? "BRL" : "USD") : null,
    lotes: lotes ? numEmail(lotes[1]) : null,
    corretora,
  };
}

// Futuros lançados pelo portal que a planilha enviada ainda não tem continuam valendo
// (mesmo Trade No., tipo e lotes = já está na planilha)
function manterFuturosDoPortal(novos, antigos) {
  const doPortal = (antigos ?? []).filter((f) => f._portal);
  const igual = (a, b) => String(a["Trade No."] ?? "") === String(b["Trade No."] ?? "") && norm(a.Tipo) === norm(b.Tipo) && Number(a.Lotes) === Number(b.Lotes);
  const faltam = doPortal.filter((p) => !novos.some((n) => igual(n, p)));
  if (faltam.length) {
    toast(`${faltam.length} futures trade(s) entered in the portal are not in this OpenFutures and were kept: ${faltam.map((f) => f["Trade No."]).join(", ")}. Add them to the spreadsheet.`, "erro");
  }
  return [...novos, ...faltam];
}

const LINHA_PLANILHA = ["Data", "Bolsa", "Tipo", "Mes/Ano", "Lotes", "Valor", "Corretora", "Notas", "Book", "Currency", "Alloc", "Trade No."];

async function novaOperacaoFuturos(ctx) {
  let futuros = [];
  try { futuros = (await ctx.api.positionFuturos?.()) ?? []; } catch { /* segue sem as listas de sugestão */ }
  const valores = (k, padrao) => [...new Set([...padrao, ...futuros.map((f) => f[k]).filter(Boolean).map(String)])];
  const opcoes = (lista, atual = "") => lista.map((v) => `<option value="${esc(v)}" ${v === atual ? "selected" : ""}>${esc(v)}</option>`).join("");
  const book = valores("Book", ["Hedge"]);
  const hoje = hojeIso();
  modal({
    titulo: "New futures trade",
    botao: "Save and recalculate",
    largura: "modal-lg",
    corpo: `<p class="muted"><span>Paste the broker confirmation e-mail and click “Read e-mail”.</span>
        <span>Check the fields, fill in Notes, Book and Alloc, and save: the trade joins the futures used by the Digisul update.</span>
        <span>Also paste the row in the spreadsheet's OpenFutures (“Copy row”).</span></p>
      <label class="campo"><span>Confirmation e-mail</span><textarea name="email" rows="5" placeholder="Dear …  Reference Number: 0Z1135-03061 …  Sell  Swap EFRS  Coffee 'C'  Dec 2026  286.156 USc/Lb …  7 lots"></textarea></label>
      <div><button type="button" class="btn" id="futLer">${icon("check")}<span>Read e-mail</span></button> <span class="muted" id="futLido"></span></div>
      <div class="fut-grade">
        <label class="campo"><span>Date (A) *</span><input type="date" name="data" value="${hoje}" required></label>
        <label class="campo"><span>Exchange (B) *</span><select name="bolsa" required><option value="">—</option>${opcoes(["NY", "LONDRES", "BMF"])}</select></label>
        <label class="campo"><span>Type (C) *</span><select name="tipo" required><option value="">—</option>${opcoes(["Compra", "Venda"])}</select></label>
        <label class="campo"><span>Month (D) *</span><input type="month" name="mes" required></label>
        <label class="campo"><span>Lots (E) *</span><input type="number" name="lotes" step="any" min="0" required></label>
        <label class="campo"><span>Price (F) *</span><input type="number" name="valor" step="any" required></label>
        <label class="campo"><span>Broker (G) *</span><input type="text" name="corretora" list="futCorretoras" required>
          <datalist id="futCorretoras">${opcoes(valores("Corretora", []))}</datalist></label>
        <label class="campo"><span>Notes (H) *</span><select name="notas" required><option value="">—</option>${opcoes(valores("Notas", ["EXP", "LOW GRADE", "CONILON"]))}</select></label>
        <label class="campo"><span>Book (I) *</span><select name="book" required>${opcoes(book, "Hedge")}</select></label>
        <label class="campo"><span>Currency (J) *</span><select name="currency" required>${opcoes(["USD", "BRL"], "USD")}</select></label>
        <label class="campo"><span>Alloc (K)</span><input type="text" name="alloc" placeholder="BRC-0000/26"></label>
        <label class="campo"><span>Trade No. (L) *</span><input type="text" name="trade" required></label>
      </div>
      <p class="muted pos-nota" id="futRepetido" hidden></p>
      <div class="fut-linha"><span class="muted">Row for the spreadsheet (A–L):</span> <code id="futLinha" data-sem-traducao></code>
        <button type="button" class="btn" id="futCopiar">${icon("file")}<span>Copy row</span></button></div>
      <div id="futDoPortal"></div>`,
    onOpen(f) {
      const campos = ["data", "bolsa", "tipo", "mes", "lotes", "valor", "corretora", "notas", "book", "currency", "alloc", "trade"];
      const linha = () => {
        const v = Object.fromEntries(campos.map((k) => [k, f[k].value.trim()]));
        const num = (x) => (x === "" ? "" : Number(x).toLocaleString("pt-BR", { maximumFractionDigits: 6 }));
        return [v.data ? `${v.data.slice(8, 10)}/${v.data.slice(5, 7)}/${v.data.slice(0, 4)}` : "", v.bolsa, v.tipo,
          v.mes ? `01/${v.mes.slice(5, 7)}/${v.mes.slice(0, 4)}` : "", num(v.lotes), num(v.valor), v.corretora, v.notas, v.book, v.currency, v.alloc, v.trade];
      };
      const atualizar = () => {
        $("#futLinha", f).textContent = linha().join(" | ");
        const tr_ = f.trade.value.trim();
        const iguais = tr_ ? futuros.filter((x) => String(x["Trade No."] ?? "") === tr_) : [];
        const aviso = $("#futRepetido", f);
        aviso.hidden = !iguais.length;
        aviso.textContent = iguais.length
          ? `${tr("Trade No. already in the futures")}: ${iguais.map((x) => `${x.Tipo} ${fmtLotes(x.Lotes)} ${tr("lots")} · ${x.Notas ?? "—"} · ${x.Alloc ?? "—"}`).join("; ")}. ${tr("The same reference can have more than one row (one per allocation).")}`
          : "";
      };
      campos.forEach((k) => f[k].addEventListener("input", atualizar));
      campos.forEach((k) => f[k].addEventListener("change", atualizar));
      $("#futLer", f).addEventListener("click", () => {
        const l = lerEmailFuturos(f.email.value, futuros);
        const mapa = { trade: l.trade, tipo: l.tipo, bolsa: l.bolsa, mes: l.mes, valor: l.valor, currency: l.currency, lotes: l.lotes, corretora: l.corretora };
        const faltou = [];
        for (const [k, v] of Object.entries(mapa)) { if (v == null || v === "") faltou.push(k); else f[k].value = String(v); }
        if (l.bolsa === "LONDRES" && !f.notas.value) f.notas.value = "CONILON";
        $("#futLido", f).textContent = faltou.length ? `${tr("Not found in the e-mail")}: ${faltou.join(", ")}` : tr("All e-mail fields read. Fill in Notes, Book and Alloc.");
        atualizar();
        (f.notas.value ? f.alloc : f.notas).focus();
      });
      $("#futCopiar", f).addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(linha().join("\t")); toast(tr("Row copied: paste it in the spreadsheet's OpenFutures.")); }
        catch { toast(tr("Could not copy — select the row and copy it by hand."), "erro"); }
      });
      atualizar();
      listarFuturosDoPortal($("#futDoPortal", f), futuros, ctx);
    },
    async onSubmit(f) {
      for (const k of ["data", "bolsa", "tipo", "mes", "lotes", "valor", "corretora", "notas", "book", "currency", "trade"]) {
        if (!f[k].value.trim()) throw new Error(tr("Fill in all the fields marked with *."));
      }
      const nova = {
        Data: serialDeIso(f.data.value), Bolsa: f.bolsa.value, Tipo: f.tipo.value, "Mes/Ano": serialDeIso(`${f.mes.value}-01`),
        Lotes: Number(f.lotes.value), Valor: Number(f.valor.value), Corretora: f.corretora.value.trim(), Notas: f.notas.value,
        Book: f.book.value, Currency: f.currency.value, "Trade No.": f.trade.value.trim(), _portal: new Date().toISOString(),
      };
      if (f.alloc.value.trim()) nova.Alloc = f.alloc.value.trim();
      await gravarFuturos(ctx, (lista) => [...lista, nova]);
      toast(`${tr("Futures trade saved")}: ${nova["Trade No."]}. ${tr("Recalculating from Digisul…")}`);
      await ctx.api.sincronizarPosition().then(() => toast(tr("Position updated from Digisul."))).catch((e) => toast(e.message, "erro"));
      guardarFonteVista("api");
      ctx.recarregar();
    },
  });
}

// troca a lista de futuros do modelo (mantém as fórmulas e o nome da planilha de origem)
async function gravarFuturos(ctx, mudar) {
  const [modelo, info] = await Promise.all([ctx.api.positionModelo(), ctx.api.positionModeloInfo?.().catch(() => null)]);
  if (!modelo) throw new Error(tr("Upload the full Position spreadsheet once before adding futures in the portal."));
  await ctx.api.salvarPositionModelo({ ...modelo, futuros: mudar(modelo.futuros ?? []) }, info?.nome_arquivo ?? "Portal");
}

// operações lançadas pelo portal, com a opção de desfazer
function listarFuturosDoPortal(alvo, futuros, ctx) {
  const lista = futuros.filter((x) => x._portal);
  if (!lista.length) { alvo.innerHTML = ""; return; }
  alvo.innerHTML = `<h3 class="pos-comp-h">Entered in the portal <span class="muted">· ${lista.length}</span></h3>
    <div class="tabela-wrap"><table class="tabela tabela-num">
      <thead><tr><th>Trade No.</th><th>Date</th><th>Exchange</th><th>Type</th><th>Month</th><th class="num">Lots</th><th class="num">Price</th><th>Notes</th><th>Alloc</th><th></th></tr></thead>
      <tbody>${lista.map((x, i) => `<tr><td>${esc(x["Trade No."])}</td><td>${esc(fmtData(isoDeSerial(x.Data)))}</td><td>${esc(x.Bolsa)}</td><td>${esc(x.Tipo)}</td>
        <td>${esc(fmtMes(isoDeSerial(x["Mes/Ano"])))}</td><td class="num">${fmtLotes(x.Lotes)}</td><td class="num">${fmtN(x.Valor, 3)}</td><td>${esc(x.Notas ?? "—")}</td><td>${esc(x.Alloc ?? "—")}</td>
        <td><button type="button" class="btn-icon" data-desfazer="${i}" title="${esc(tr("Remove"))}" aria-label="${esc(tr("Remove"))}">${icon("trash")}</button></td></tr>`).join("")}</tbody>
    </table></div>`;
  $$("[data-desfazer]", alvo).forEach((b) => b.addEventListener("click", async () => {
    const x = lista[Number(b.dataset.desfazer)];
    if (!confirm(`${tr("Remove the futures trade")} ${x["Trade No."]} (${x.Tipo} ${fmtLotes(x.Lotes)} ${tr("lots")})?`)) return;
    b.disabled = true;
    try {
      await gravarFuturos(ctx, (todos) => todos.filter((y) => y._portal !== x._portal));
      toast(tr("Futures trade removed. Recalculating from Digisul…"));
      await ctx.api.sincronizarPosition().catch((e) => toast(e.message, "erro"));
      $$(".modal-bg").at(-1)?.querySelector("[data-close]")?.click();
      ctx.recarregar();
    } catch (e) { toast(e.message, "erro"); b.disabled = false; }
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
        <span class="pos-kpi-s">Net diff position <span>${fmtSinal(kpis[k].diff)}</span></span>
        ${delta != null ? `<span class="pos-kpi-d">${delta === 0 ? "No change vs previous" : `<b>${delta > 0 ? "▲" : "▼"} ${fmtSinal(delta)}</b> vs previous`}</span>` : ""}
      </button>`;
    }).join("")}</div>

    <section class="pos-card">
      <div class="pos-card-h pos-card-h-linha"><div><h2>Net position by term month · ${NOME_GRUPO[grupo]}</h2>
        <p class="muted">⊞ opens the fixed and PTBF breakdown of purchases and sales.</p></div>
        <button type="button" class="btn" id="termmTudo">${abertosTermM.size ? "Hide breakdown" : "Show breakdown"}</button></div>
      ${b.meses.length ? "" : `<p class="muted pos-nota">The spreadsheet has no term-month breakdown for ${NOME_GRUPO[grupo]} — only the total below. The month-by-month view is in Physical Position.</p>`}
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num pos-termm">
        <thead>${cabecalhoTermM()}</thead>
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
    ${cardAlteracoes(carga.resumo, FILTRO_GRUPO_ALT[grupo], NOME_GRUPO[grupo])}
    ${ctx.gerente ? cardComparacao(grupo, carga, outra, modeloInfo, ctx) : ""}`;

    $$("[data-grupo]", alvo).forEach((el) => el.addEventListener("click", () => { grupo = el.dataset.grupo; desenhar(); }));
    $("#posOficial", alvo)?.addEventListener("click", () => trocarFonteOficial(ctx));
    ligarAlteracoes(alvo, desenhar);
    // detalhamento das compras e vendas: abre/fecha por grupo ou tudo de uma vez
    $$("[data-abrir]", alvo).forEach((el) => el.addEventListener("click", () => {
      const g = el.dataset.abrir;
      if (abertosTermM.has(g)) abertosTermM.delete(g); else abertosTermM.add(g);
      guardarAbertosTermM(); desenhar();
    }));
    $("#termmTudo", alvo).addEventListener("click", () => {
      if (abertosTermM.size) abertosTermM.clear(); else GRUPOS_TERMM.forEach((g) => abertosTermM.add(g.k));
      guardarAbertosTermM(); desenhar();
    });
    if (hist.length >= 2) {
      await graficoLinha($("#gHist", alvo), { rotulos: hist.map((h) => fmtData(h.data_ref)), dados: hist.map((h) => h.kpis[grupo].outright), rotulo: "Net outright" });
    }
  };
  await desenhar();
}

// O que mudou desde a última versão de um dia anterior (resumo.alteracoes), filtrado
// pelo grupo da tela: { especie: "A"|"C" } ou { grupo: "EXP"|"LOW GRADE" }.
const ROT_TIPO_ALT = { c: "Purchase", v: "Export sale", i: "Domestic sale", e: "Inventory" };
const CHAVE_ALT = "bi-alteracoes-aberto";
let alteracoesAbertas = (() => { try { return localStorage.getItem(CHAVE_ALT) === "1"; } catch { return false; } })();

// modo: "dia" = contra a última versão de um dia anterior; "ultima" = contra a atualização anterior
let modoAlteracoes = "dia";

function cardAlteracoes(resumo, filtro, rotulo) {
  const porModo = { dia: resumo?.alteracoes, ultima: resumo?.alteracoes_ultima };
  const modo = porModo[modoAlteracoes] ? modoAlteracoes : porModo.dia ? "dia" : "ultima";
  const alt = porModo[modo];
  if (!alt) {
    return `<section class="pos-card"><div class="pos-card-h"><h2>What changed since the previous position</h2>
      <p class="muted">The comparison appears from the next position onwards (each version keeps a snapshot of the contracts).</p></div></section>`;
  }
  const titulo = modo === "dia" ? `What changed since ${fmtData(alt.desde)}` : `What changed since the last update (${dataHoraBR(alt.desde)})`;
  const alternar = porModo.dia && porModo.ultima
    ? segmentos("segModoAlt", [["dia", "Since the previous day"], ["ultima", "Since the last update"]], modo) : "";
  const passa = (x) => (filtro.especie ? x.especie === filtro.especie : x.grupo === filtro.grupo);
  const itens = alt.itens.filter(passa);
  const movs = itens.filter((x) => !x.fixacao), fixs = itens.filter((x) => x.fixacao);
  const contratos = movs.filter((x) => x.tipo !== "e").sort((a, b) => Math.abs(b.efeito) - Math.abs(a.efeito));
  const lotes = movs.filter((x) => x.tipo === "e");
  const soma = (l) => l.reduce((s, x) => s + x.efeito, 0);
  const total = soma(movs);
  const porTipo = ["c", "v", "i", "e"].map((t) => [t, movs.filter((x) => x.tipo === t)]).filter(([, l]) => l.length);
  // estoque resumido por qualidade: lotes que entraram, saíram e mudaram
  const porPadrao = new Map();
  for (const x of lotes) {
    const p = porPadrao.get(x.padrao ?? "—") ?? porPadrao.set(x.padrao ?? "—", { entrou: [], saiu: [], mudou: [] }).get(x.padrao ?? "—");
    (x.motivo === "New lot" ? p.entrou : x.motivo === "Lot out" ? p.saiu : p.mudou).push(x);
  }
  const listaLotes = (l) => l.map((x) => `${x.chave} (${fmtN(x.efeito)})`).join(", ");
  const celLotes = (l) => (l.length ? `<td class="num" title="${esc(listaLotes(l))}">${fmtN(soma(l))} <span class="muted">· ${l.length}</span></td>` : `<td class="num"><span class="zero">–</span></td>`);
  return `<section class="pos-card">
    <div class="pos-card-h pos-card-h-linha"><div><h2>${esc(titulo)} · ${esc(rotulo)}</h2>
      <p class="muted">${modo === "dia" ? "Contracts and lots that changed against the last position of the previous day, and the effect on the physical position (bags)."
        : "Contracts and lots that changed against the previous update, and the effect on the physical position (bags)."}</p></div>
      <div class="pos-acoes">${alternar}<button type="button" class="btn" id="altAbrir">${alteracoesAbertas ? "Hide details" : "Show details"}</button></div></div>
    <div class="pos-alt-resumo">
      <span class="pos-alt-total">Physical effect <strong>${fmtSinal(Math.round(total))}</strong> bags</span>
      ${porTipo.map(([t, l]) => `<span>${ROT_TIPO_ALT[t]}: <strong>${fmtSinal(Math.round(soma(l)))}</strong> <span class="muted">(${l.length})</span></span>`).join("")}
      ${fixs.length ? `<span>Fixations: <strong>${fmtN(fixs.reduce((s, x) => s + (x.antes - x.agora), 0))}</strong> bags <span class="muted">(${fixs.length})</span></span>` : ""}
      ${!movs.length && !fixs.length ? `<span class="muted">No changes.</span>` : ""}
    </div>
    ${resumoAlteracoes(itens)}
    ${alteracoesAbertas && contratos.length ? `<div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
      <thead><tr><th>Type</th><th>Contract</th><th>Counterparty</th><th>Quality</th><th class="num">Before</th><th class="num">Now</th><th class="num">Physical effect</th><th>What happened</th></tr></thead>
      <tbody>${contratos.map((x) => `<tr><td>${ROT_TIPO_ALT[x.tipo]}</td><td>${esc(x.chave)}</td><td>${esc(x.parceiro ?? "—")}</td><td>${esc(x.padrao ?? "—")}</td>
        ${celNum(x.antes)}${celNum(x.agora)}${celNum(x.efeito, { forte: true })}<td>${esc(x.motivo)}</td></tr>`).join("")}</tbody>
    </table></div>` : ""}
    ${alteracoesAbertas && porPadrao.size ? `<div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
      <thead><tr><th>Inventory by quality</th><th class="num">Lots in</th><th class="num">Lots out</th><th class="num">Lots changed</th><th class="num">Net</th></tr></thead>
      <tbody>${[...porPadrao].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })).map(([p, g]) => `<tr><td>${esc(p)}</td>
        ${celLotes(g.entrou)}${celLotes(g.saiu)}${celLotes(g.mudou)}${celNum(soma([...g.entrou, ...g.saiu, ...g.mudou]), { forte: true })}</tr>`).join("")}</tbody>
    </table></div><p class="muted pos-nota">Hover a number to see the lots. Lot changes are usually reprocessing, blends, deliveries and shipments.</p>` : ""}
    ${alteracoesAbertas && fixs.length ? `<div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
      <thead><tr><th>Fixation</th><th>Contract</th><th>Counterparty</th><th>Quality</th><th class="num">To fix before</th><th class="num">To fix now</th><th class="num">Fixed</th></tr></thead>
      <tbody>${fixs.map((x) => `<tr><td>${ROT_TIPO_ALT[x.tipo]}</td><td>${esc(x.chave)}</td><td>${esc(x.parceiro ?? "—")}</td><td>${esc(x.padrao ?? "—")}</td>
        ${celNum(x.antes)}${celNum(x.agora)}${celNum(x.antes - x.agora, { forte: true })}</tr>`).join("")}</tbody>
    </table></div>` : ""}
  </section>`;
}
// Resumo escrito, por grupo (Exportável / Low Grade / Conilon): contrato novo, entrega
// (casada com os lotes que ela gerou no estoque), embarque, movimentação de lotes e fixações.
const SECOES_ALT = [["EXP", "Exportable"], ["LOW GRADE", "Low Grade"], ["CONILON", "Conilon"], [null, "Other qualities"]];
const PALAVRAS_FORA = /^(LTDA|S\.?A\.?|ME|EIRELI|EPP|DE|DA|DO|DAS|DOS|E|EM)$/i;
// nome curto do parceiro: o que vem antes do " - " ou as três primeiras palavras
function nomeCurto(s) {
  if (!s) return "—";
  const base = String(s).includes(" - ") ? String(s).split(" - ")[0] : String(s).split(/\s+/).filter((w) => !PALAVRAS_FORA.test(w)).slice(0, 3).join(" ");
  return base.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function resumoAlteracoes(itens) {
  if (!itens.length) return "";
  const soma = (l) => l.reduce((s, x) => s + x.efeito, 0);
  const lotesTxt = (l, max = 6) => l.slice(0, max).map((x) => x.chave).join(", ") + (l.length > max ? ` +${l.length - max}` : "");
  const quem = (x, comSacas) => `<b>${esc(x.chave)}</b> <span class="muted" title="${esc(x.parceiro ?? "")}">(${esc(nomeCurto(x.parceiro))}, ${esc(x.padrao ?? "—")}${comSacas ? `, ${fmtN(comSacas)} sc` : ""})</span>`;
  const ef = (v) => `<strong class="pos-alt-ef">${fmtSinal(Math.round(v))}</strong>`;
  const secoes = [];
  for (const [grupo, nome] of SECOES_ALT) {
    const doGrupo = itens.filter((x) => (x.grupo ?? null) === grupo);
    if (!doGrupo.length) continue;
    const movs = doGrupo.filter((x) => !x.fixacao), fixs = doGrupo.filter((x) => x.fixacao);
    const lotes = movs.filter((x) => x.tipo === "e");
    const usados = new Set();
    const linhas = [];
    for (const x of movs.filter((m) => m.tipo !== "e").sort((a, b) => Math.abs(b.efeito) - Math.abs(a.efeito))) {
      const q = Math.abs(x.agora - x.antes);
      if (x.tipo === "c" && (x.motivo === "Delivery" || x.motivo === "Delivered / closed")) {
        // lotes novos com o contrato desta compra = o café que entrou no estoque com a entrega
        const daEntrega = lotes.filter((l) => l.parceiro === x.chave && l.efeito > 0);
        daEntrega.forEach((l) => usados.add(l));
        const est = soma(daEntrega);
        linhas.push([`${quem(x)} — <span>delivery of ${fmtN(q)} sc</span>${daEntrega.length ? `, <span>${daEntrega.length} new lots in inventory</span>` : ""}`,
          daEntrega.length ? `<span class="muted">Purchases ${fmtN(x.efeito)} · Inventory ${fmtSinal(Math.round(est))}</span> ${ef(x.efeito + est)}` : `<span class="muted">Purchases</span> ${ef(x.efeito)}`]);
        continue;
      }
      const txt = {
        "c|New purchase": "new purchase contract", "c|Increase": "increase",
        "v|New sale": "new export sale", "v|Shipment": "shipment", "v|Shipped / closed": "shipment", "v|Increase": "increase",
        "i|New sale": "new domestic sale", "i|Delivery": "delivery", "i|Delivered / closed": "delivery", "i|Increase": "increase",
      }[`${x.tipo}|${x.motivo}`] ?? x.motivo;
      const novo = x.motivo.startsWith("New");
      const conta = { c: "Purchases", v: "Exp sales", i: "Int sales" }[x.tipo];
      linhas.push([`${quem(x, novo ? x.agora : null)} — <span>${txt}${novo ? "" : ` of ${fmtN(q)} sc`}</span>`, `<span class="muted">${conta}</span> ${ef(x.efeito)}`]);
    }
    // lotes que sobraram: rebeneficiamentos, ligas, saídas para embarque
    const resto = lotes.filter((l) => !usados.has(l));
    if (resto.length) {
      const entrou = resto.filter((l) => l.efeito > 0), saiu = resto.filter((l) => l.efeito < 0);
      const padroes = [...new Set(resto.map((l) => l.padrao).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      linhas.push([`<b>Lot movements</b> <span class="muted">(${esc(padroes.join(", "))})</span> — ${saiu.length ? `<span title="${esc(saiu.map((l) => `${l.chave} (${fmtN(l.efeito)})`).join(", "))}">${saiu.length} lots out or reduced</span> <span class="muted">(${esc(lotesTxt(saiu))})</span>` : ""}${saiu.length && entrou.length ? "; " : ""}${entrou.length ? `<span title="${esc(entrou.map((l) => `${l.chave} (+${fmtN(l.efeito)})`).join(", "))}">${entrou.length} lots in or increased</span> <span class="muted">(${esc(lotesTxt(entrou))})</span>` : ""}`,
        `<span class="muted">Inventory</span> ${ef(soma(resto))}`]);
    }
    for (const x of fixs) {
      const fixado = x.antes - x.agora;
      const out = (x.tipo === "c" ? 1 : -1) * fixado;
      linhas.push([`${quem(x)} — <span>${fixado > 0 ? `fixed ${fmtN(fixado)} sc` : `${fmtN(-fixado)} sc more to fix`}</span>`, `<span class="muted">Outright</span> ${ef(out)}`]);
    }
    secoes.push(`<div class="pos-alt-secao"><h3>${nome}: ${ef(soma(movs))} <span class="muted">bags</span></h3>
      <table class="tabela"><thead><tr><th>Movement</th><th class="num">Effect</th></tr></thead>
      <tbody>${linhas.map(([m, e]) => `<tr><td>${m}</td><td class="num nowrap">${e}</td></tr>`).join("")}</tbody></table></div>`);
  }
  return `<div class="pos-alt-texto">${secoes.join("")}</div>`;
}

function ligarAlteracoes(alvo, redesenhar) {
  ligarSegmentos(alvo, "segModoAlt", (k) => { modoAlteracoes = k; redesenhar(); });
  $("#altAbrir", alvo)?.addEventListener("click", () => {
    alteracoesAbertas = !alteracoesAbertas;
    try { localStorage.setItem(CHAVE_ALT, alteracoesAbertas ? "1" : "0"); } catch { /* sem armazenamento */ }
    redesenhar();
  });
}
const FILTRO_GRUPO_ALT = { arabica: { especie: "A" }, robusta: { especie: "C" }, exportable: { grupo: "EXP" }, lowgrade: { grupo: "LOW GRADE" } };

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

// Colunas da TermM. Compras e vendas abrem o detalhamento (as colunas vermelhas da
// planilha: fixado e PTBF); fechadas mostram só o total. Estado lembrado no navegador.
const GRUPOS_TERMM = [
  { k: "purchases", rot: "Purchases", det: [["purchases_fixed", "Fixed"], ["purchases_ptbf", "PTBF"]] },
  { k: "sales", rot: "Sales", det: [["exp_sales", "Exp sales"], ["exp_fixed", "Fixed"], ["exp_ptbf", "PTBF"],
    ["int_sales", "Int sales"], ["int_fixed", "Fixed"], ["int_ptbf", "PTBF"]] },
];
const CHAVE_TERMM = "bi-termm-abertos";
const abertosTermM = new Set((() => { try { return JSON.parse(localStorage.getItem(CHAVE_TERMM)) ?? []; } catch { return []; } })());
const guardarAbertosTermM = () => { try { localStorage.setItem(CHAVE_TERMM, JSON.stringify([...abertosTermM])); } catch { /* sem armazenamento */ } };
// colunas na ordem da planilha: [chave, rótulo, é detalhe?]
function colunasTermM() {
  const g = (k) => GRUPOS_TERMM.find((x) => x.k === k);
  const grupo = (k) => [[k, "Total", false], ...(abertosTermM.has(k) ? g(k).det.map(([c, r]) => [c, r, true]) : [])];
  return [["cash", "Cash", false], ...grupo("purchases"), ["inventory", "Inventory", false], ...grupo("sales"),
    ["futures", "Total", false], ["futures_ptbf", "PTBF", false], ["switch_exp", "Switch exp.", false]];
}

function cabecalhoTermM() {
  const botao = (k) => {
    const aberto = abertosTermM.has(k), x = GRUPOS_TERMM.find((g) => g.k === k);
    return `<th colspan="${aberto ? x.det.length + 1 : 1}" class="pbi-grupo"><button type="button" data-abrir="${k}" aria-expanded="${aberto}"
      title="${aberto ? "Collapse" : "Expand"}">${aberto ? "⊟" : "⊞"}</button> ${x.rot}</th>`;
  };
  const sub = colunasTermM().filter(([k]) => k !== "cash" && k !== "inventory" && k !== "switch_exp")
    .map(([, rot, det]) => `<th class="${det ? "det" : ""}">${rot}</th>`).join("");
  return `<tr><th rowspan="2">Term month</th><th rowspan="2">Cash</th>${botao("purchases")}<th rowspan="2">Inventory</th>${botao("sales")}
      <th colspan="2">Futures</th><th rowspan="2">Switch exp.</th><th rowspan="2">Net diff position</th><th rowspan="2">Net outright</th></tr>
    <tr>${sub}</tr>`;
}

function linhaTermM(rotulo, m, total = false) {
  const tag = total ? "th" : "td";
  return `<tr class="${total ? "total" : ""}"><${tag} scope="row">${esc(rotulo)}</${tag}>${colunasTermM()
    .map(([k]) => celNum(m[k], { forte: total })).join("")}${celNum(m.net_diff, { forte: true })}${celNum(m.net_outright, { forte: true })}</tr>`;
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
const numPbi = (v) => (Math.abs(v) < 0.5 ? "" : fmtN(v));

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
          const qs = estado.recolhidos.has(g.nome) ? "" : g.qualidades.map((c) => { const v = acumulado[c][i]; return `<td class="pbi-cel ${v < -0.5 ? "neg" : ""}" data-g="${esc(c)}" data-qs="${esc(c)}" data-i="${i}" title="${esc(tr("Click to see the contracts and lots"))}">${numPbi(v)}</td>`; }).join("");
          return `${qs}<td class="pbi-tot pbi-cel ${classe(t)}" data-g="${esc(g.nome)}" data-qs="${esc(g.qualidades.join(","))}" data-i="${i}">${numPbi(t)}</td>`;
        }).join("");
        return `<tr><th scope="row">${esc(mesLongo(m))}</th>${cels}<td class="pbi-total pbi-cel ${classe(geral)}" data-g="Total" data-qs="${esc(grupos.flatMap((g) => g.qualidades).join(","))}" data-i="${i}">${numPbi(geral)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>
  </section>`;
}

// Composição de uma célula da matriz por padrão (acumulado até o mês da célula):
// lotes do estoque, compras e vendas, conforme os componentes ligados na tela.
const COMPONENTES_FIS = ["inventory", "purchases", "exp_sales", "domestic_sales"]; // ordem de position-calc
const ROT_COMP_FIS = ["Inventory", "Purchases", "Export Sales", "Domestic Sales"];
const ROT_ID_FIS = { e: ["Lot", "Warehouse"], c: ["Contract", "Supplier"], v: ["Contract", "Importer"], i: ["Contract", "Client"] };
let composicaoCache = null;

async function abrirComposicao(ctx, estado, { rotulo, qualidades, i, mes, valor }) {
  if (!ctx?.api?.positionDetalhe) return;
  try {
    composicaoCache ??= ctx.api.positionDetalhe(["fisica_itens"]).then((d) => d.fisica_itens ?? null);
    const fi = await composicaoCache;
    const dados = fi?.[estado.especie === "conilon" ? "conilon" : "arabica"];
    if (!dados) throw new Error("Upload the Position again (or update from Digisul) to see what makes up each number.");
    const ligados = estado.comps.size ? COMPS_FISICA.map(([k]) => k).filter((k) => estado.comps.has(k)) : COMPS_FISICA.map(([k]) => k);
    const comps = new Set(ligados.map((k) => COMPONENTES_FIS.indexOf(k)));
    const qs = new Set(qualidades);
    const itens = dados.itens.filter((x) => qs.has(x[0]) && x[2] <= i && comps.has(x[1]));
    // por componente; dentro dele, uma linha por contrato/lote (soma dos meses)
    const secoes = [0, 1, 2, 3].filter((c) => comps.has(c)).map((c) => {
      const porChave = new Map();
      for (const x of itens.filter((y) => y[1] === c)) {
        const k = `${x[4]}|${x[0]}`;
        const l = porChave.get(k) ?? porChave.set(k, { tipo: x[3], chave: x[4], parceiro: x[5], padrao: x[0], meses: new Set(), v: 0 }).get(k);
        l.meses.add(x[2]); l.v += x[6];
      }
      const todas = [...porChave.values()].filter((l) => Math.abs(l.v) > 1e-6);
      const linhas = todas.filter((l) => Math.abs(l.v) >= 0.5).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
      // resíduos de menos de meia saca ficam numa linha só, para a soma bater com a célula
      const miudos = todas.filter((l) => Math.abs(l.v) < 0.5);
      const vMiudos = miudos.reduce((s, l) => s + l.v, 0);
      if (miudos.length && Math.abs(vMiudos) >= 0.005) {
        linhas.push({ tipo: miudos[0].tipo, chave: `${miudos.length} × < ½`, parceiro: tr("Remainders under half a bag"), padrao: "", meses: new Set(miudos.flatMap((l) => [...l.meses])), v: vMiudos });
      }
      return { c, linhas, total: todas.reduce((s, l) => s + l.v, 0) };
    }).filter((s) => s.linhas.length);
    const total = secoes.reduce((s, x) => s + x.total, 0);
    const variasQ = qs.size > 1;
    const mesesTxt = (l) => [...l.meses].sort((a, b) => a - b).map((m) => mesLongo(dados.meses[m])).join(", ");
    modal({
      titulo: `${rotulo} · ${mesLongo(mes)}`,
      largura: "modal-lg",
      corpo: `<p><span>Accumulated position up to</span> <b>${esc(mesLongo(mes))}</b>: <strong class="pos-alt-ef">${esc(valor)}</strong> <span>bags</span></p>
        <div class="pos-alt-resumo">${secoes.map((s) => `<span>${esc(tr(ROT_COMP_FIS[s.c]))}: <strong class="pos-alt-ef">${fmtN(Math.round(s.total))}</strong></span>`).join("")}</div>
        ${valor && Math.abs(Math.abs(total) - (Number(String(valor).replace(/[^\d]/g, "")) || 0)) > 1
          ? `<p class="muted pos-nota">${icon("info")} Sum of the lines: ${fmtN(Math.round(total))} bags.</p>` : ""}
        ${secoes.map((s) => {
          const [rotChave, rotParc] = ROT_ID_FIS[s.linhas[0].tipo];
          return `<h3 class="pos-comp-h">${tr(ROT_COMP_FIS[s.c])} <span class="muted">· ${s.linhas.length} · ${fmtN(Math.round(s.total))} bags</span></h3>
          <div class="tabela-wrap"><table class="tabela tabela-num">
            <thead><tr><th>${rotChave}</th><th>${rotParc}</th>${variasQ ? "<th>Quality</th>" : ""}${s.c ? "<th>Month</th>" : ""}<th class="num">Bags</th></tr></thead>
            <tbody>${s.linhas.map((l) => `<tr><td>${esc(l.chave ?? "—")}</td><td>${esc(l.parceiro ?? "—")}</td>${variasQ ? `<td>${esc(l.padrao)}</td>` : ""}${s.c ? `<td>${esc(mesesTxt(l))}</td>` : ""}${celNum(l.v)}</tr>`).join("")}</tbody>
          </table></div>`;
        }).join("") || `<p class="muted">No contracts or lots in this cell.</p>`}`,
    });
    // os negativos do modal também ficam em vermelho
    const m = $$(".modal").at(-1);
    if (m) { m.classList.add("pos"); marcarNegativos(m); }
  } catch (e) {
    composicaoCache = null;
    toast(e.message, "erro");
  }
}

async function painelFisica(alvo, carga, ctx) {
  composicaoCache = null;
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
    </section>
    ${cardAlteracoes(carga.resumo, { especie: estado.especie === "conilon" ? "C" : "A" }, estado.especie === "conilon" ? "Conilon" : "Arabica")}`;

    ligarAlteracoes(alvo, desenhar);
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
    // clique num número da matriz: contratos e lotes que formam aquele saldo
    $$(".pbi-cel", alvo).forEach((td) => td.addEventListener("click", () => abrirComposicao(ctx, estado, {
      rotulo: td.dataset.g, qualidades: td.dataset.qs.split(",").filter(Boolean), i: Number(td.dataset.i),
      mes: mesesMatriz()[Number(td.dataset.i)], valor: td.textContent.trim(),
    })));
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
  let bolsaSel = "NY", unidade = "lotes";
  const abas = () => [...Object.entries(TABELAS).map(([k, d]) => [k, `${d.titulo} (${(detalhes[k] ?? []).length})`]),
    ["bolsa", "By exchange month"],
    ...(logistica ? [["logistica", `Stuffed, pending stock exit (${logistica.length})`]] : [])];

  const desenhar = () => {
    if (aba === "bolsa") {
      alvo.innerHTML = painelBolsa(detalhes, carga.resumo.termm, { bolsa: bolsaSel, unidade }, abas());
      ligarSegmentos(alvo, "segAba", (k) => { aba = k; qualidade = ""; busca = ""; mes = ""; fix = ""; ordem = null; desenhar(); });
      ligarSegmentos(alvo, "segBolsaMes", (k) => { bolsaSel = k; desenhar(); });
      ligarSegmentos(alvo, "segUnidade", (k) => { unidade = k; desenhar(); });
      $$(".pos-cel-clic", alvo).forEach((td) => td.addEventListener("click", () =>
        abrirContratosBolsa(detalhes, { bolsa: bolsaSel, unidade }, td.dataset.col, td.dataset.yms)));
      return;
    }
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

// Por mês da bolsa (Z26, H27…): comprado e vendido, fixado e a fixar, dos contratos em
// aberto, mais os futuros da TermM. Em lotes (padrão) ou em sacas.
const SACAS_POR_LOTE = { NY: 283.5, LONDRES: 500 / 3 };
const COD_MES_BOLSA = "FGHJKMNQUVXZ";
const codigoBolsa = (ym) => `${COD_MES_BOLSA[Number(ym.slice(5, 7)) - 1]}${ym.slice(2, 4)}`;

function painelBolsa(detalhes, termm, { bolsa, unidade }, abas) {
  const lote = SACAS_POR_LOTE[bolsa];
  const emLotes = unidade === "lotes";
  const meses = new Map();
  const linha = (ym) => meses.get(ym) ?? meses.set(ym, { ym, cT: 0, cF: 0, cA: 0, eT: 0, eF: 0, eA: 0, iT: 0, iF: 0, iA: 0, fut: 0 }).get(ym);
  // compras (c), vendas de exportação (e) e internas (i): total, fixado, a fixar
  for (const [tipo, p] of [["purchases", "c"], ["expsales", "e"], ["intsales", "i"]]) {
    for (const r of detalhes[tipo] ?? []) {
      const m = r[CAMPO_MES[tipo]];
      if (norm(r.bolsa) !== bolsa || !m) continue;
      const l = linha(m.slice(0, 7));
      if (emLotes) {
        l[p + "T"] += r.lotes ?? 0; l[p + "F"] += r.lotes_fixados ?? 0; l[p + "A"] += r.lotes_a_fixar ?? 0;
      } else {
        const aFixar = r.a_fixar ?? 0;
        l[p + "T"] += r.sacas ?? 0; l[p + "F"] += (r.sacas ?? 0) - aFixar; l[p + "A"] += aFixar;
      }
    }
  }
  // futuros: coluna FUTURES da TermM (sacas; NY = Arábica, Londres = Robusta)
  for (const m of termm?.[bolsa === "NY" ? "arabica" : "robusta"]?.meses ?? []) {
    if (!m.futures) continue;
    linha(m.mes.slice(0, 7)).fut += emLotes ? m.futures / lote : m.futures;
  }
  // meses já vencidos só aparecem se ainda houver o que fixar (aí ficam marcados)
  const mesAtual = hojeIso().slice(0, 7);
  const temAFixar = (l) => Math.abs(l.cA) > 0.05 || Math.abs(l.eA + l.iA) > 0.05;
  const lista = [...meses.values()].filter((l) => l.ym >= mesAtual || temAFixar(l)).sort((a, b) => a.ym.localeCompare(b.ym));
  const tot = lista.reduce((t, l) => { for (const k of Object.keys(t)) t[k] += l[k]; return t; },
    { cT: 0, cF: 0, cA: 0, eT: 0, eF: 0, eA: 0, iT: 0, iF: 0, iA: 0, fut: 0 });
  const f = (v) => (emLotes ? fmtLotes(v) : fmtN(v));
  // célula com número abre os contratos que a formam (abrirContratosBolsa); futuros não têm contrato
  const c = (v, forte = false, col = null, yms = "") => (Math.abs(v) < 0.05
    ? `<td class="num ${forte ? "forte" : ""}"><span class="zero">–</span></td>`
    : `<td class="num ${forte ? "forte" : ""}${col ? " pos-cel-clic" : ""}"${col ? ` data-col="${col}" data-yms="${yms}" title="${esc(tr("Click to see the contracts"))}"` : ""}>${f(v)}</td>`);
  const vendas = (l, k) => l["e" + k] + l["i" + k];
  const corpo = (l, total = false) => {
    const aFixar = l.cA - vendas(l, "A");
    const yms = total ? lista.map((x) => x.ym).join(",") : l.ym;
    return `${c(l.cT, total, "cT", yms)}${c(l.cF, total, "cF", yms)}${c(l.cA, total, "cA", yms)}
      ${c(vendas(l, "T"), total, "vT", yms).replace("<td ", `<td title="${esc(`${tr("Export")}: ${f(l.eT)} · ${tr("Domestic")}: ${f(l.iT)}`)}" `)}
      ${c(vendas(l, "F"), total, "vF", yms)}${c(vendas(l, "A"), total, "vA", yms)}${c(l.fut, total)}${c(aFixar, true, "net", yms)}`;
  };
  return `
    <div class="pos-filtros">
      ${segmentos("segAba", abas, "bolsa")}
      ${segmentos("segBolsaMes", [["NY", "NY (Arabica)"], ["LONDRES", "London (Robusta)"]], bolsa)}
      ${segmentos("segUnidade", [["lotes", "Lots"], ["sacas", "Bags"]], unidade)}
    </div>
    <p class="muted pos-nota">${icon("info")} <span>Open contracts by exchange month (purchases by "Mês Bolsa", sales by "Fixar Mês"). Sales are shown as positive quantities. Futures: net lots of the TermM (negative = sold). Net to fix = purchases to fix − sales to fix. Past months only appear while they still have lots to fix (marked in red).</span> <span>Click a number to see the contracts.</span></p>
    <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
      <thead>
        <tr><th rowspan="2">Exchange month</th><th colspan="3">Purchases</th><th colspan="3">Sales (export + domestic)</th>
          <th rowspan="2">Futures</th><th rowspan="2">Net to fix</th></tr>
        <tr><th>Total</th><th>Fixed</th><th>To fix</th><th>Total</th><th>Fixed</th><th>To fix</th></tr>
      </thead>
      <tbody>${lista.length ? lista.map((l) => `<tr class="${l.ym < mesAtual ? "linha-alerta" : ""}"><td><strong>${codigoBolsa(l.ym)}</strong> <span class="muted">${esc(fmtMes(l.ym + "-01"))}</span></td>${corpo(l)}</tr>`).join("")
        : `<tr><td colspan="9" class="vazio-td">No open contracts for this exchange.</td></tr>`}</tbody>
      ${lista.length ? `<tfoot><tr class="total"><th scope="row">Total</th>${corpo(tot, true)}</tr></tfoot>` : ""}
    </table></div>`;
}

// Contratos atrás de uma célula do "por mês da bolsa": mesma conta do painel
// (lotes: Qtd. Lotes / Lotes Fixado / Lotes a Fixar; sacas: Sacas / Sacas − a fixar / a fixar)
const TIPOS_BOLSA = [["purchases", "Purchase", "fornecedor"], ["expsales", "Export", "importador"], ["intsales", "Domestic", "cliente"]];
function abrirContratosBolsa(detalhes, { bolsa, unidade }, col, yms) {
  const emLotes = unidade === "lotes";
  const meses = new Set(yms.split(","));
  const [lado, med] = col === "net" ? ["*", "A"] : [col[0], col[1]];
  const val = (r, k) => (emLotes
    ? ({ T: r.lotes, F: r.lotes_fixados, A: r.lotes_a_fixar }[k] ?? 0)
    : ({ T: r.sacas ?? 0, F: (r.sacas ?? 0) - (r.a_fixar ?? 0), A: r.a_fixar ?? 0 }[k]));
  const linhas = TIPOS_BOLSA.filter(([tipo]) => lado === "*" || (lado === "c") === (tipo === "purchases")).flatMap(([tipo, rot, parc]) =>
    (detalhes[tipo] ?? []).filter((r) => norm(r.bolsa) === bolsa && meses.has(r[CAMPO_MES[tipo]]?.slice(0, 7)) && Math.abs(val(r, med)) >= 0.005)
      .map((r) => ({ r, tipo, rot, parc: r[parc], sinal: col === "net" && tipo !== "purchases" ? -1 : 1 })));
  linhas.sort((a, b) => (a.tipo === "purchases" ? 0 : 1) - (b.tipo === "purchases" ? 0 : 1) || Math.abs(val(b.r, med)) - Math.abs(val(a.r, med)));
  const f = (v) => (emLotes ? fmtLotes(v) : fmtN(v));
  const soma = (k, comSinal = false) => linhas.reduce((s, x) => s + val(x.r, k) * (comSinal ? x.sinal : 1), 0);
  const rotCol = { T: "Total", F: "Fixed", A: "To fix" }[med];
  const titulo = `${col === "net" ? tr("Net to fix") : `${tr(lado === "c" ? "Purchases" : "Sales")} · ${tr(rotCol)}`} · ${
    meses.size === 1 ? `${codigoBolsa(yms)} ${fmtMes(yms + "-01")}` : tr("all months")}`;
  modal({
    titulo,
    largura: "modal-lg",
    corpo: `<div class="pos-alt-resumo"><span><span>Contracts</span>: <strong>${fmtN(new Set(linhas.map((x) => x.r.contrato)).size)}</strong></span>
        <span>${esc(tr(rotCol))}: <strong class="pos-alt-ef">${f(col === "net" ? soma("A", true) : soma(med))}</strong> ${esc(tr(emLotes ? "lots" : "bags"))}</span></div>
      ${col === "net" ? `<p class="muted pos-nota">Purchases to fix minus sales to fix (sales count as negative).</p>` : ""}
      <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
        <thead><tr><th>Contract</th><th>Type</th><th>Counterparty</th><th>Quality</th><th>Month</th><th>Fixation</th>
          <th class="num">Total</th><th class="num">Fixed</th><th class="num">To fix</th></tr></thead>
        <tbody>${linhas.length ? linhas.map(({ r, tipo, rot, parc, sinal }) => `<tr><td>${esc(r.contrato)}</td><td>${esc(tr(rot))}</td><td>${esc(parc ?? "—")}</td>
            <td>${esc(r.padrao ?? "—")}</td><td>${esc(fmtMes(r[CAMPO_MES[tipo]]))}</td><td>${esc(r.status_fix ?? "—")}</td>
            ${["T", "F", "A"].map((k) => `<td class="num${k === med ? " forte" : ""}">${f(val(r, k) * (k === "A" ? sinal : 1))}</td>`).join("")}</tr>`).join("")
          : `<tr><td colspan="9" class="vazio-td">No contracts.</td></tr>`}</tbody>
        ${linhas.length ? `<tfoot><tr class="total"><th scope="row" colspan="6">Total</th>
          ${col === "net" ? `<td></td><td></td>` : `<td class="num">${f(soma("T"))}</td><td class="num">${f(soma("F"))}</td>`}<td class="num">${f(soma("A", col === "net"))}</td></tr></tfoot>` : ""}
      </table></div>`,
  });
  const m = $$(".modal").at(-1);
  if (m) { m.classList.add("pos"); marcarNegativos(m); }
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
  const a = Math.abs(v);
  const txt = a >= 1e6 ? `${moeda}${fmtN(a / 1e6, 2)}M` : a >= 1e3 ? `${moeda}${fmtN(a / 1e3, 1)}K` : `${moeda}${fmtN(a)}`;
  return v < 0 ? `(${txt})` : txt;
};
// variação contra o ano anterior: % para volumes e valores, diferença absoluta para preços/diferenciais
function yoy(atual, ant, { abs = false, dec = 2 } = {}) {
  if (atual == null || ant == null || (!abs && !ant)) return `<span class="muted">—</span>`;
  const d = atual - ant;
  if (Math.abs(d) < 1e-9) return `<span class="yoy">= 0</span>`;
  const seta = d > 0 ? "▲" : "▼";
  const txt = abs ? `${d > 0 ? "+" : ""}${fmtN(d, dec)}` : `${d > 0 ? "+" : ""}${fmtN((d / Math.abs(ant)) * 100, 0, "%")}`;
  return `<span class="yoy">${seta} ${txt}</span>`;
}
const barra = (v, max) => `<span class="cel-barra"><i style="width:${max ? Math.max(0, Math.min(100, (v / max) * 100)) : 0}%"></i><b>${fmtN(v)}</b></span>`;
const fmtSinalDec = (v) => (v > 0 ? "+" : "") + fmtN(v, 2);
const pct = (v, base) => (base ? fmtN((v / base) * 100, 1, "%") : "—");

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

// =====================================================================
// DASHBOARD COMMERCIAL — antes um relatório do Power BI sobre a aba ExpSales.
// Mesmas medidas de lá: diferencial médio = média simples por linha (Conilon ÷ 100),
// sacas = Sacas, entregues = Saída (sc), a entregar = Saldo (sc), cliente padronizado.
// =====================================================================
const TIPO_PADRAO = {
  FC: ["BCSW", "BC1", "BC+", "BC2", "BC3"], GC: ["BC4", "BC5", "BC6", "BC17"], GRINDERS: ["BC8", "BC9"],
  LG: ["BC10", "BC11", "BC12", "BC13"], CONILON: ["BC14", "BC15", "BC16"],
};
const ORDEM_TIPO = Object.keys(TIPO_PADRAO);
const ORDEM_PADRAO = Object.values(TIPO_PADRAO).flat();
const tipoPadrao = (p) => ORDEM_TIPO.find((k) => TIPO_PADRAO[k].includes(p)) ?? null;
const ordemTipo = (a, b) => ORDEM_TIPO.indexOf(a) - ORDEM_TIPO.indexOf(b);
const ordemPadrao = (a, b) => (ORDEM_PADRAO.indexOf(a) + 1 || 99) - (ORDEM_PADRAO.indexOf(b) + 1 || 99) || a.localeCompare(b);
// "JULY 2026" / "JULHO DE 2026"
const rotMesLongo = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }).toUpperCase();
const fmtDif = (v) => (v == null ? "—" : fmtN(v, 2));

function medidasComercial(linhas) {
  const m = { sacas: 0, saida: 0, saldo: 0, contratos: 0, dif: null, difA: null, difC: 0 };
  const ctr = new Set(), s = { g: [0, 0], a: [0, 0], c: [0, 0] };
  for (const r of linhas) {
    m.sacas += r.sacas ?? 0; m.saida += r.saida ?? 0; m.saldo += r.saldo ?? 0; ctr.add(r.contrato);
    if (r._dif == null) continue;
    s.g[0] += r._dif; s.g[1]++;
    if (r._esp === "ARABICA") { s.a[0] += r._dif; s.a[1]++; } else if (r._esp === "CONILON") { s.c[0] += r._dif; s.c[1]++; }
  }
  m.contratos = ctr.size;
  if (s.g[1]) m.dif = s.g[0] / s.g[1];
  if (s.a[1]) m.difA = s.a[0] / s.a[1];
  if (s.c[1]) m.difC = s.c[0] / s.c[1];  // sem Conilon no filtro: 0, como no Power BI
  return m;
}

// valores escritos em cima das barras e dos pontos
const rotulosGrafico = {
  id: "rotulos",
  afterDatasetsDraw(chart) {
    const { ctx } = chart, t = tema();
    ctx.save();
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = t.tinta2; ctx.textAlign = "center";
    chart.data.datasets.forEach((ds, i) => {
      chart.getDatasetMeta(i).data.forEach((el, j) => {
        const v = ds.data[j];
        if (v == null) return;
        ctx.textBaseline = v < 0 ? "top" : "bottom";
        ctx.fillText(fmtN(v, 2), el.x, el.y + (v < 0 ? 4 : -4));
      });
    });
    ctx.restore();
  },
};

// selecao: qualidades escolhidas (as outras barras ficam apagadas); Ctrl+clique soma à escolha
async function graficoQualidades(canvas, itens, aoClicar, selecao = new Set()) {
  const Chart = await carregarChart();
  const t = tema();
  const apagada = /^#[0-9a-f]{6}$/i.test(t.s1) ? `${t.s1}55` : t.grade;
  const cores = itens.map((x) => (!selecao.size || selecao.has(x.padrao) ? t.s1 : apagada));
  const c = new Chart(canvas, {
    type: "bar",
    data: { labels: itens.map((x) => x.padrao), datasets: [{ data: itens.map((x) => arred(x.m.dif)), backgroundColor: cores, borderRadius: 3, maxBarThickness: 34 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, layout: { padding: { top: 18, bottom: 4 } },
      onClick: (e, els) => { if (els.length) aoClicar(itens[els[0].index].padrao, e.native?.ctrlKey || e.native?.metaKey); },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 } }, grace: "8%" },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (ctx) => `${tr("Quality")} ${ctx[0].label}`,
          label: (ctx) => {
            const { m } = itens[ctx.dataIndex];
            return [` ${tr("Avg diff")}: ${fmtDif(m.dif)}`, ` ${tr("Delivered")}: ${fmtN(m.saida)} ${tr("bags")}`, ` ${tr("To deliver")}: ${fmtN(m.saldo)} ${tr("bags")}`];
          },
        } },
      },
    },
    plugins: [rotulosGrafico],
  });
  graficos.push(c);
}

async function graficoHistorico(canvas, { rotulos, arabica, conilon }) {
  const Chart = await carregarChart();
  const t = tema();
  const linha = (rot, dados, cor) => ({ label: tr(rot), data: dados, borderColor: cor, backgroundColor: cor, borderWidth: 2, tension: 0.35,
    pointRadius: 3, pointHoverRadius: 5, pointBorderColor: t.sup, pointBorderWidth: 2, spanGaps: true });
  const c = new Chart(canvas, {
    type: "line",
    data: { labels: rotulos, datasets: [linha("Avg diff Arabica", arabica, t.s1), linha("Avg diff Conilon", conilon, t.s2)] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, layout: { padding: { top: 18 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: t.grade }, ticks: { color: t.muda, font: { size: 11 } } },
        y: { grid: { color: t.grade }, border: { display: false }, ticks: { color: t.muda, font: { size: 11 } }, grace: "10%" },
      },
      plugins: {
        legend: { position: "bottom", align: "start", labels: { color: t.tinta2, boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtDif(ctx.raw)}` } },
      },
    },
    plugins: [rotulosGrafico],
  });
  graficos.push(c);
}

async function painelComercial(alvo, carga, ctx) {
  let dados = null;
  try { dados = (await ctx.api.positionDetalhe(["comercial"])).comercial ?? null; } catch { /* cai no aviso abaixo */ }
  if (!dados) {
    alvo.innerHTML = `<p class="muted pos-nota pos-nota-bloco">${icon("info")} Upload the Position again (or update from Digisul) to build this view — it needs every row of the ExpSales sheet.</p>`;
    return;
  }
  for (const r of dados) {
    r._esp = norm(r.especie);
    r._dif = r.diferencial == null ? null : r._esp === "CONILON" ? r.diferencial / 100 : r.diferencial;
    r._cliente = clientePadronizado(r);
    r._tipo = tipoPadrao(r.padrao);
    r._emb = mesIso(r.embarque);
    r._inc = mesIso(r.inclusao);
  }
  // segmentações do Power BI: [chave, rótulo, valor da linha, ordem, texto da opção]
  // (as listas só mostram linhas com grupo de qualidade, como lá)
  const alfa = (a, b) => a.localeCompare(b);
  const FILTROS = [
    ["tipo", "Quality group", (r) => r._tipo, ordemTipo],
    ["eom", "EOM Ship", (r) => r._emb, alfa, rotMesLongo],
    ["padrao", "Quality", (r) => r.padrao, ordemPadrao],
    ["peneira", "Screen", (r) => r.peneira, alfa],
    ["cliente", "Client", (r) => r._cliente, alfa],
    ["especie", "Variety", (r) => r.especie, alfa],
  ];
  // cada filtro é um conjunto de valores escolhidos (vazio = todos), como no Power BI
  const filtro = Object.fromEntries(FILTROS.map(([k]) => [k, new Set()]));
  const hoje = mesIso(hojeIso());
  let de = `${hoje.slice(0, 4)}-01`, ate = hoje;
  const abertos = new Set();
  let listaAberta = null; // filtro com a lista de escolha aberta (continua aberta ao redesenhar)
  const passa = (r, exceto) => FILTROS.every(([k, , val]) => k === exceto || !filtro[k].size || filtro[k].has(val(r)));
  // clique escolhe só aquele valor (de novo: limpa); Ctrl+clique soma ou tira da seleção
  const selecionar = (k, v, varios) => {
    const s = filtro[k];
    if (varios) { if (!s.delete(v)) s.add(v); }
    else if (s.size === 1 && s.has(v)) s.clear();
    else { s.clear(); s.add(v); }
    desenhar();
  };
  // destaque do que foi escolhido no próprio visual (o resto fica apagado)
  const marca = (k, v) => (!filtro[k].size ? "" : filtro[k].has(v) ? " on" : " apagado");

  // a embarcar: mês de embarque > grupo > qualidade > peneira. Como o filtro "Sacas a Entregar ≥ 1"
  // do Power BI, vale no nível mais fino: só entram as linhas de combinações com saldo ≥ 1,
  // e as médias dos níveis de cima são calculadas só sobre elas.
  const NIVEIS = [
    [(r) => r._emb ?? "", alfa, (v) => (v ? rotMesLongo(v) : tr("No date"))],
    [(r) => r._tipo ?? "", ordemTipo, (v) => v || "—"],
    [(r) => r.padrao ?? "", ordemPadrao, (v) => v || "—"],
    [(r) => r.peneira ?? "", alfa, (v) => v || "—"],
  ];
  const linhasArvore = (rows, nivel, caminho) => {
    const [chave, ordem, rotulo] = NIVEIS[nivel];
    const grupos = new Map();
    for (const r of rows) { const k = chave(r); (grupos.get(k) ?? grupos.set(k, []).get(k)).push(r); }
    return [...grupos.keys()].sort(ordem).flatMap((k) => {
      const g = grupos.get(k), mg = medidasComercial(g);
      const id =`${caminho}\u0001${k}`, folha = nivel === NIVEIS.length - 1, aberto = !folha && abertos.has(id);
      const tog = folha ? `<span class="pos-com-folha"></span>`
        : `<button type="button" class="pos-com-tog" data-no="${esc(id)}" aria-expanded="${aberto}" title="${aberto ? "Collapse" : "Expand"}">${aberto ? "⊟" : "⊞"}</button>`;
      // os meses filtram a página (clique e Ctrl+clique)
      const mes = nivel === 0 && k ? ` data-eom="${esc(k)}"` : "";
      return [`<tr class="pos-com-n${nivel}${mes ? ` pos-clic${marca("eom", k)}` : ""}"${mes}><td style="padding-left:${10 + nivel * 18}px">${tog}${esc(rotulo(k))}</td>${celNum(mg.saldo)}
        <td class="num">${fmtDif(mg.difA)}</td><td class="num">${fmtDif(mg.difC)}</td></tr>`,
        ...(aberto ? linhasArvore(g, nivel + 1, id) : [])];
    });
  };

  const desenhar = async () => {
    limparGraficos();
    const linhas = dados.filter((r) => passa(r));
    const m = medidasComercial(linhas);
    // opções de cada lista: o que existe com os outros filtros (e o que já está escolhido)
    const opcoes = (k, val, ordem) => [...new Set([...dados.filter((r) => r._tipo && passa(r, k)).map(val).filter(Boolean), ...filtro[k]])].sort(ordem);
    // cada visual mostra tudo da própria dimensão (com a escolha em destaque) e filtra pelos outros
    const semFiltro = (k) => dados.filter((r) => passa(r, k));
    // último contrato registrado: o da maior data de inclusão; a data mostrada é a maior emissão
    const ult = linhas.reduce((u, r) => (r.inclusao && (!u || r.inclusao > u.inclusao || (r.inclusao === u.inclusao && r.contrato > u.contrato)) ? r : u), null);
    const emissao = linhas.reduce((x, r) => (r.emissao && (!x || r.emissao > x) ? r.emissao : x), null);

    const porCliente = [...semFiltro("cliente").reduce((mp, r) => mp.set(r._cliente, (mp.get(r._cliente) ?? 0) + (r.sacas ?? 0)), new Map())]
      .filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
    const maxCli = porCliente[0]?.[1] ?? 0;
    const folha = (r) => NIVEIS.map(([chave]) => chave(r)).join("\u0001");
    const linhasEmb = semFiltro("eom");
    const saldoFolha = linhasEmb.reduce((mp, r) => mp.set(folha(r), (mp.get(folha(r)) ?? 0) + (r.saldo ?? 0)), new Map());
    const aEmbarcar = linhasEmb.filter((r) => saldoFolha.get(folha(r)) >= 1);
    const mE = medidasComercial(aEmbarcar);
    const arvore = linhasArvore(aEmbarcar, 0, "");

    // diferencial médio por qualidade, do maior para o menor
    const porPadrao = [...semFiltro("padrao").reduce((mp, r) => (r.padrao ? mp.set(r.padrao, [...(mp.get(r.padrao) ?? []), r]) : mp), new Map())]
      .map(([padrao, rows]) => ({ padrao, m: medidasComercial(rows) })).filter((x) => x.m.dif != null).sort((a, b) => b.m.dif - a.m.dif);

    // histórico pelo mês da data de inclusão
    const meses = mesesEntre(de, ate).filter((mes) => linhas.some((r) => r._inc === mes));
    const porMes = new Map(meses.map((mes) => [mes, medidasComercial(linhas.filter((r) => r._inc === mes))]));
    const temConilon = (mes) => linhas.some((r) => r._inc === mes && r._esp === "CONILON" && r._dif != null);

    const algumFiltro = FILTROS.some(([k]) => filtro[k].size);
    // lista de escolha com caixinhas (várias opções), busca, "todos" e "limpar"
    const lista = ([k, rot, val, ordem, fmt]) => {
      const sel = filtro[k], txt = (v) => (fmt ? fmt(v) : v);
      const resumo = !sel.size ? tr("All") : sel.size === 1 ? txt([...sel][0]) : `${sel.size} ${tr("selected")}`;
      const ops = opcoes(k, val, ordem);
      return `<div class="pos-mes pos-multi${listaAberta === k ? " aberta" : ""}" data-multi="${k}"><span>${esc(tr(rot))}</span>
        <button type="button" class="pos-multi-b${sel.size ? " ativo" : ""}" aria-haspopup="listbox" aria-expanded="${listaAberta === k}"><span>${esc(resumo)}</span><span class="pos-multi-seta" aria-hidden="true">▾</span></button>
        <div class="pos-multi-p" role="listbox" aria-multiselectable="true">
          ${ops.length > 8 ? `<input type="search" class="pos-multi-busca" placeholder="${esc(tr("Search…"))}" aria-label="${esc(tr("Search"))}">` : ""}
          <div class="pos-multi-acoes"><button type="button" data-todos>${esc(tr("Select all"))}</button><button type="button" data-limpar>${esc(tr("Clear"))}</button></div>
          <div class="pos-multi-ops">${ops.map((v) => `<label><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? "checked" : ""}><span>${esc(txt(v))}</span></label>`).join("")}</div>
        </div></div>`;
    };
    alvo.innerHTML = `
    <div class="pos-com-cab">
      <h2>${esc(filtro.cliente.size === 1 ? [...filtro.cliente][0] : tr("Dashboard Commercial"))}</h2>
      ${ult ? `<span class="muted"><span>Last contract:</span> <strong>${esc(ult.contrato)}</strong> (${esc(fmtData(emissao))})</span>` : ""}
    </div>
    <div class="pos-filtros">
      ${FILTROS.map(lista).join("")}
      ${algumFiltro ? `<button type="button" class="btn" id="comLimpar">${icon("x")}<span>Clear filters</span></button>` : ""}
    </div>
    <p class="muted pos-nota">${icon("info")} <span>Click a client, a shipment month or a quality bar to filter the page; Ctrl+click to pick more than one.</span></p>
    <div class="pos-kpis pos-kpis-fix">
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Total contracts</span><span class="pos-kpi-v">${fmtN(m.contratos)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Total bags</span><span class="pos-kpi-v">${fmtN(m.sacas)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Avg diff Arabica</span><span class="pos-kpi-v">${fmtDif(m.difA)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Avg diff Conilon</span><span class="pos-kpi-v">${fmtDif(m.difC)}</span></div>
      <div class="pos-kpi pos-kpi-est"><span class="pos-kpi-t">Bags to be delivered</span><span class="pos-kpi-v">${fmtN(m.saldo)}</span></div>
    </div>
    <div class="pos-duas">
      <section class="pos-card">
        <div class="pos-card-h"><h2>Bags per client</h2></div>
        <div class="tabela-wrap pos-tabela pos-com-alto"><table class="tabela tabela-num">
          <tbody>${porCliente.length ? porCliente.map(([cli, v]) => `<tr class="pos-clic${marca("cliente", cli)}" data-cliente="${esc(cli)}"><td>${esc(cli)}</td><td class="num">${barra(v, maxCli)}</td></tr>`).join("")
            : `<tr><td class="vazio-td">No data for these filters.</td></tr>`}</tbody>
        </table></div>
      </section>
      <section class="pos-card">
        <div class="pos-card-h"><h2>To be shipped</h2><p class="muted">⊞ opens the quality group, the quality and the screen.</p></div>
        <div class="tabela-wrap pos-tabela pos-com-alto"><table class="tabela tabela-num pos-com-arvore">
          <thead><tr><th>Shipment</th><th class="num">Bags to be delivered</th><th class="num">Avg diff Arabica</th><th class="num">Avg diff Conilon</th></tr></thead>
          <tbody>${arvore.join("") || `<tr><td colspan="4" class="vazio-td">Nothing left to ship for these filters.</td></tr>`}</tbody>
          ${arvore.length ? `<tfoot><tr class="total"><th scope="row">Total</th>${celNum(mE.saldo, { forte: true })}<td class="num forte">${fmtDif(mE.difA)}</td><td class="num forte">${fmtDif(mE.difC)}</td></tr></tfoot>` : ""}
        </table></div>
      </section>
    </div>
    <div class="pos-duas">
      <section class="pos-card">
        <div class="pos-card-h"><h2>Avg diff per quality</h2><p class="muted">Simple average of the contract lines; Conilon diffs ÷ 100.</p></div>
        ${porPadrao.length ? `<div class="pos-grafico"><canvas id="gComQual" role="img" aria-label="Average diff per quality"></canvas></div>` : `<p class="vazio-td">No data for these filters.</p>`}
      </section>
      <section class="pos-card">
        <div class="pos-card-h pos-card-h-linha"><div><h2>Historical diff</h2><p class="muted">By month of the inclusion date.</p></div>
          <div class="pos-filtros"><label class="pos-mes"><span>From</span><input type="month" id="comDe" value="${de}"></label>
          <label class="pos-mes"><span>To</span><input type="month" id="comAte" value="${ate}"></label></div></div>
        ${meses.length ? `<div class="pos-grafico"><canvas id="gComHist" role="img" aria-label="Average diff by month"></canvas></div>` : `<p class="vazio-td">No contracts included in this period.</p>`}
      </section>
    </div>`;

    // listas de escolha: abre/fecha no botão; cada caixinha redesenha com a lista ainda aberta
    $$("[data-multi]", alvo).forEach((caixa) => {
      const k = caixa.dataset.multi, p = $(".pos-multi-p", caixa);
      $(".pos-multi-b", caixa).addEventListener("click", () => {
        listaAberta = listaAberta === k ? null : k;
        $$("[data-multi]", alvo).forEach((c) => c.classList.toggle("aberta", c.dataset.multi === listaAberta));
        if (listaAberta) $(".pos-multi-busca", caixa)?.focus();
      });
      const aplicar = (valores) => {
        const rolagem = $(".pos-multi-ops", caixa).scrollTop;
        filtro[k] = new Set(valores);
        desenhar().then(() => { const o = $(`[data-multi="${k}"] .pos-multi-ops`, alvo); if (o) o.scrollTop = rolagem; });
      };
      $$("input[type=checkbox]", p).forEach((cb) => cb.addEventListener("change", () =>
        aplicar($$("input[type=checkbox]:checked", p).map((x) => x.value))));
      $("[data-todos]", p).addEventListener("click", () => aplicar($$("input[type=checkbox]", p).filter((x) => !x.closest("label").hidden).map((x) => x.value)));
      $("[data-limpar]", p).addEventListener("click", () => aplicar([]));
      $(".pos-multi-busca", p)?.addEventListener("input", (e) => {
        const q = norm(e.target.value);
        $$("label", p).forEach((l) => { l.hidden = !!q && !norm(l.textContent).includes(q); });
      });
    });
    $("#comLimpar", alvo)?.addEventListener("click", () => { FILTROS.forEach(([k]) => filtro[k].clear()); listaAberta = null; desenhar(); });
    $$("tr[data-cliente]", alvo).forEach((l) => l.addEventListener("click", (e) => selecionar("cliente", l.dataset.cliente, e.ctrlKey || e.metaKey)));
    $$("tr[data-eom]", alvo).forEach((l) => l.addEventListener("click", (e) => selecionar("eom", l.dataset.eom, e.ctrlKey || e.metaKey)));
    $$(".pos-com-tog", alvo).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();  // abrir o mês não filtra
      if (!abertos.delete(b.dataset.no)) abertos.add(b.dataset.no);
      desenhar();
    }));
    $("#comDe", alvo)?.addEventListener("change", (e) => { if (!e.target.value) return; de = e.target.value; if (de > ate) ate = de; desenhar(); });
    $("#comAte", alvo)?.addEventListener("change", (e) => { if (!e.target.value) return; ate = e.target.value; if (ate < de) de = ate; desenhar(); });

    if (porPadrao.length) {
      await graficoQualidades($("#gComQual", alvo), porPadrao, (p, varios) => selecionar("padrao", p, varios), filtro.padrao);
    }
    if (meses.length) {
      await graficoHistorico($("#gComHist", alvo), {
        rotulos: meses.map(rotMes),
        arabica: meses.map((mes) => (porMes.get(mes).difA == null ? null : arred(porMes.get(mes).difA))),
        conilon: meses.map((mes) => (temConilon(mes) ? arred(porMes.get(mes).difC) : null)),
      });
    }
  };
  // clique fora da lista aberta fecha (uma vez por página)
  const fechar = (e) => {
    if (!alvo.isConnected) { document.removeEventListener("click", fechar); return; }
    if (listaAberta && !e.target.closest?.("[data-multi]")) {
      listaAberta = null;
      $$("[data-multi]", alvo).forEach((c) => c.classList.remove("aberta"));
    }
  };
  document.addEventListener("click", fechar);
  await desenhar();
}
