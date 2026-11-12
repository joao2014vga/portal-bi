// =====================================================================
// SHIPMENT — programação de embarque (a antiga planilha "Shipment")
// Exportações ainda não embarcadas, com os dados do Digisul (retrato diário do
// brascof-api, /api/qualidade?view=shipment) e três campos que o time preenche
// à mão, porque o Digisul não liga a guia de serviço ao contrato BRAS:
//   GUIA  "R-667", "BRC-0006/26", "OK", "SEM GUIA", "COMPRA BANCO"...
//   OBS   texto livre
//   LOCAL armazém onde o café está / vai ser preparado
// Gravados em bi_shipment (seção 27 do supabase/schema.sql), um por contrato.
//
// O que o Digisul tem serve para conferir o que foi digitado:
//   - guia R-xxx: aberta/fechada, padrão e armazém da guia; fechada, o lote que
//     ela gerou no estoque (Doc_Origem "Guia de Serviço R-xxx/2026")
//   - guia BRC: o contrato de compra (fornecedor, padrão, sacas)
//   - LOCAL: sugerido pelo armazém da guia ou pelo local de estufagem
// =====================================================================
import { esc, $, $$, icon, toast, confirmar, tempoRelativo, storage } from "./ui.js";
import { fmtN, fmtData, fmtMes, carregarXlsx, vigiarNegativos } from "./position.js";
import { LOCALE, t } from "./i18n.js";

export const ehPainelShipment = (link) => /^portal:shipment$/.test(link ?? "");

const CHAVE_FILTROS = "portalbi_shipment_filtros";
const SEM_GUIA = ["SEM GUIA", "OK", "COMPRA BANCO"]; // o que já se usa na planilha quando não há guia R

// =====================================================================
// REGRAS (sem tela: dá para testar à parte)
// =====================================================================
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const RUIDO_LOCAL = new Set(["ARMAZENS", "ARMAZEM", "ARM.", "ARM", "GERAIS", "LTDA", "LTDA.", "LT", "S.A.", "SA"]);

// "CAMPO VERDE ARMAZENS GERAIS LT" → "CAMPO VERDE"; "ACAUA ARM. GERAIS | ARAXA-MG" → "ACAUA";
// "EXPOCACCER - COOP. D | PATROCINIO-MG" → "EXPOCACCER"; "ARMAZENS GERAIS LESTE DE MINAS" → "LESTE DE MINAS"
export function localCurto(s) {
  if (!s) return null;
  const x = norm(s).split("|")[0].split(" - ")[0].replace(/COMERCIO EXTERIOR E/g, " ");
  return x.split(" ").filter((p) => p && !RUIDO_LOCAL.has(p)).join(" ") || null;
}
export function mesmoLocal(a, b) {
  const x = localCurto(a), y = localCurto(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// "R-667", "r 667", "R-667/26", "R-667/2026" → { base: "R-667", ano: "26" | null }
export function lerGuiaR(txt) {
  const m = norm(txt).match(/^R\s*-?\s*0*(\d+)\s*(?:\/\s*(?:20)?(\d{2}))?$/);
  return m ? { base: `R-${m[1]}`, ano: m[2] ?? null } : null;
}
// "BRC-0006/26", "brc 6/26", "BRC-0497/26A" → "BRC-0006/26"
export function lerBRC(txt) {
  const m = norm(txt).match(/^BRC\s*-?\s*(\d+)\s*\/\s*(?:20)?(\d{2})\s*([A-Z])?$/);
  return m ? `BRC-${m[1].padStart(4, "0")}/${m[2]}${m[3] ?? ""}` : null;
}
// tipo do que foi digitado na GUIA
export function tipoGuia(txt) {
  const s = norm(txt);
  if (!s || s === "-") return "vazio";
  if (lerGuiaR(s)) return "guia";
  if (lerBRC(s)) return "compra";
  if (s === "SEM GUIA") return "sem";
  return "texto"; // OK, COMPRA BANCO e o que mais o time usar
}
// LOCAL vazio ou "-" (a planilha usa "-" para "ainda não sei")
const semLocal = (v) => { const s = String(v ?? "").trim(); return !s || s === "-"; };
const mesmoPadrao = (a, b) => !a || !b || norm(a) === norm(b);

export function indexar(d) {
  const guias = new Map(); // "R-667" -> guias com esse número, a mais nova primeiro
  for (const g of d.guias ?? []) {
    const r = lerGuiaR(g.guia);
    if (!r) continue;
    if (!guias.has(r.base)) guias.set(r.base, []);
    guias.get(r.base).push({ ...g, _ano: r.ano });
  }
  for (const l of guias.values()) l.sort((a, b) => String(b.abertura ?? "").localeCompare(String(a.abertura ?? "")));
  const lotes = new Map(); // "R-634/26" -> lotes gerados pela guia
  for (const l of d.lotes_guia ?? []) {
    if (!lotes.has(l.guia)) lotes.set(l.guia, []);
    lotes.get(l.guia).push(l);
  }
  const compras = new Map((d.compras ?? []).map((c) => [norm(c.contrato), c]));
  return { guias, lotes, compras };
}
export function acharGuia(ix, txt) {
  const r = lerGuiaR(txt);
  if (!r) return null;
  const l = ix.guias.get(r.base) ?? [];
  return (r.ano ? l.find((g) => g._ano === r.ano) : l[0]) ?? null;
}
export function acharCompra(ix, txt) {
  const k = lerBRC(txt);
  if (!k) return null;
  const semLetra = k.replace(/[A-Z]$/, "");
  return ix.compras.get(k) ?? ix.compras.get(semLetra)
    ?? [...ix.compras.entries()].find(([c]) => c.startsWith(semLetra))?.[1] ?? null;
}

// Confere uma linha. `ed` = { guia, obs, local } digitados; `uso` = sacas de todos os
// contratos que apontam para cada guia (uma guia pode servir vários contratos).
// Devolve { tipo, guia, compra, lotes, sugestao, avisos: [{ nivel: 'critico'|'alerta'|'info', txt }] }
export function analisar(r, ed, ix, { hoje, uso }) {
  const avisos = [];
  const tipo = tipoGuia(ed?.guia);
  const guia = tipo === "guia" ? acharGuia(ix, ed.guia) : null;
  const compra = tipo === "compra" ? acharCompra(ix, ed.guia) : null;
  const lotes = guia ? ix.lotes.get(guia.guia) ?? [] : [];

  if (tipo === "guia" && !guia) avisos.push({ nivel: "critico", txt: t("Order {g} not found in Digisul", { g: ed.guia }) });
  if (guia) {
    if (!mesmoPadrao(guia.padrao, r.padrao)) avisos.push({ nivel: "alerta", txt: t("Order is {a}, contract is {b}", { a: guia.padrao, b: r.padrao }) });
    for (const l of lotes) if (!mesmoPadrao(l.padrao, r.padrao)) avisos.push({ nivel: "alerta", txt: t("Lot {l} is {a}, contract is {b}", { l: l.lote, a: l.padrao, b: r.padrao }) });
    const total = uso?.get(guia.guia);
    if (guia.fechamento && guia.saida != null && total && guia.saida < total * 0.99 - 1)
      avisos.push({ nivel: "alerta", txt: t("Order gave {a} bags; contracts on it need {b}", { a: fmtN(guia.saida), b: fmtN(total) }) });
  }
  if (tipo === "compra") {
    if (!compra) avisos.push({ nivel: "info", txt: t("Purchase {c} not found in Digisul", { c: ed.guia }) });
    else if (!mesmoPadrao(compra.padrao, r.padrao)) avisos.push({ nivel: "alerta", txt: t("Purchase is {a}, contract is {b}", { a: compra.padrao, b: r.padrao }) });
  }

  // LOCAL: o armazém da guia ou o local de estufagem do contrato
  const fontes = [guia?.armazem, r.local].filter(Boolean);
  const sugestao = localCurto(fontes[0]);
  const local = norm(ed?.local);
  if (local && local !== "-" && fontes.length && !fontes.some((f) => mesmoLocal(local, f)))
    avisos.push({ nivel: "alerta", txt: t("Warehouse differs from Digisul ({x})", { x: fontes.map(localCurto).filter(Boolean).join(" / ") }) });

  // carrega logo e ainda não tem guia
  if ((tipo === "vazio" || tipo === "sem") && r.prev_carga) {
    const dias = Math.round((Date.parse(r.prev_carga) - Date.parse(hoje)) / 864e5);
    if (dias < 0) avisos.push({ nivel: "critico", txt: t("Loading date passed and no order") });
    else if (dias <= 7) avisos.push({ nivel: "alerta", txt: dias === 0 ? t("Loads today and no order") : t("Loads in {n} days and no order", { n: dias }) });
  }
  return { tipo, guia, compra, lotes, sugestao, avisos };
}

// sacas de todos os contratos que apontam para cada guia
export function usoDasGuias(rows, edicoes, ix) {
  const uso = new Map();
  for (const r of rows) {
    const g = acharGuia(ix, edicoes.get(r.contrato)?.guia);
    if (g) uso.set(g.guia, (uso.get(g.guia) ?? 0) + (r.sacas ?? 0));
  }
  return uso;
}

// =====================================================================
// COLUNAS (a ordem da planilha)
// =====================================================================
// [chave, rótulo, tipo] — tipo: t texto, n número, n2, d data, m mês, ed campo editável
const COLS = [
  ["cliente", "Client", "t"], ["contrato", "Contract", "t"], ["referencia", "Client ref.", "t"], ["sacas", "Bags", "n"], ["peso", "Weight (kg)", "n"],
  ["padrao", "Quality", "t"], ["peneira", "Screen", "t"],
  ["guia", "Service order", "ed"], ["obs", "Notes", "ed"], ["local_ed", "Warehouse", "ed"], ["_check", "Check", "check"],
  ["prev_carga", "Exp. loading", "d"], ["embarque", "Shipment", "m"], ["safras", "Crop", "t"], ["local", "Stuffing place", "t"],
  ["certificador", "Certificate", "t"], ["diferencial", "Differential", "n2"], ["status_amostra", "Sample", "t"], ["envio_amostra", "Sample sent", "d"],
  ["qualidade", "Description", "t"], ["oic", "ICO", "t"], ["dead_cafe", "Coffee deadline", "d"], ["destino", "Destination", "t"],
  ["booking", "Booking", "t"], ["armador", "Carrier", "t"], ["navio", "Vessel", "t"], ["emissao", "Issued", "d"], ["containers", "Containers", "n"],
];
const CAMPO = { guia: "guia", obs: "obs", local_ed: "local" };
const NUM = new Set(["n", "n2"]);
const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));

function fmtCel(v, tipo) {
  if (v == null || v === "") return "";
  if (tipo === "n") return fmtN(v);
  if (tipo === "n2") return fmtN(v, 2);
  if (tipo === "d") return ehData(v) ? fmtData(v) : String(v);
  if (tipo === "m") return ehData(v) ? fmtMes(v) : String(v);
  return String(v);
}

// =====================================================================
// TELA
// =====================================================================
export async function renderShipment(link, alvo, ctx) {
  vigiarNegativos(alvo);
  const api = ctx.api;
  let dados, ix, edicoes = new Map(), erroEdicao = null;
  let salvos = {};
  try { salvos = JSON.parse(storage.get(CHAVE_FILTROS) ?? "{}") ?? {}; } catch { /* filtro salvo inválido */ }
  const filtros = { filial: null, ate: "next", situacao: "", cliente: "", busca: "", ...salvos };
  const guardarFiltros = () => storage.set(CHAVE_FILTROS, JSON.stringify({ filial: filtros.filial, ate: filtros.ate, situacao: filtros.situacao }));

  const carregar = async (fresco = false) => {
    alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> ${fresco ? "Fetching the latest data from Digisul…" : "Loading the shipment schedule…"}</div>`;
    erroEdicao = null;
    try {
      const [d, ed] = await Promise.all([
        api.qualidade("shipment", fresco),
        api.shipmentEdicoes().catch((e) => { erroEdicao = e.message; return []; }),
      ]);
      dados = d;
      ix = indexar(d);
      edicoes = new Map(ed.map((e) => [e.contrato, e]));
    } catch (e) {
      alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Digisul data is not available</h3><p>${esc(e.message)}</p>
        <button class="btn" id="shpTentar">${icon("refresh")}<span>Try again</span></button></div>`;
      $("#shpTentar", alvo)?.addEventListener("click", () => carregar(true));
      return;
    }
    // filial padrão: a de MG (a planilha é a de Minas); fica a última escolhida
    const filiais = [...new Set(dados.exportacao.map((r) => r.filial).filter(Boolean))].sort();
    if (filtros.filial == null || (filtros.filial && !filiais.includes(filtros.filial))) filtros.filial = filiais.find((f) => /MG/.test(f)) ?? "";
    desenhar();
  };

  // ---------------------------------------------------------------- filtro
  const mesLimite = () => {
    if (filtros.ate === "all") return null;
    const [a, m] = dados.hoje.split("-").map(Number);
    const tot = a * 12 + m - 1 + (filtros.ate === "3" ? 3 : 1);
    return `${Math.floor(tot / 12)}-${String((tot % 12) + 1).padStart(2, "0")}`;
  };
  function linhasFiltradas() {
    const lim = mesLimite();
    const q = norm(filtros.busca);
    const uso = usoDasGuias(dados.exportacao, edicoes, ix);
    return dados.exportacao
      .filter((r) => !filtros.filial || r.filial === filtros.filial)
      .filter((r) => !lim || !r.embarque || r.embarque.slice(0, 7) <= lim)
      .filter((r) => !filtros.cliente || r.cliente === filtros.cliente)
      .map((r) => ({ r, a: analisar(r, edicoes.get(r.contrato), ix, { hoje: dados.hoje, uso }) }))
      .filter(({ r }) => {
        if (!q) return true;
        const e = edicoes.get(r.contrato) ?? {};
        return [r.contrato, r.cliente, r.importador, r.referencia, r.booking, e.guia, e.obs, e.local].some((x) => norm(x).includes(q));
      })
      // como na planilha: pela previsão de carga (sem data no fim), depois o contrato
      .sort((x, y) => (x.r.prev_carga ?? "9999").localeCompare(y.r.prev_carga ?? "9999") || x.r.contrato.localeCompare(y.r.contrato, LOCALE, { numeric: true }));
  }
  // situação de cada linha: é o que o filtro "Service order" e os cards de cima escolhem
  const SITUACOES = {
    none: ({ a }) => a.tipo === "vazio" || a.tipo === "sem",
    week: (x) => SITUACOES.none(x) && !!x.r.prev_carga && x.r.prev_carga <= somarDias(dados.hoje, 7),
    alert: ({ a }) => a.avisos.some((v) => v.nivel !== "info"),
  };

  // ---------------------------------------------------------------- desenho
  function desenhar() {
    const filiais = [...new Set(dados.exportacao.map((r) => r.filial).filter(Boolean))].sort();
    const clientes = [...new Set(dados.exportacao.filter((r) => !filtros.filial || r.filial === filtros.filial).map((r) => r.cliente).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, LOCALE));
    const em = new Date(dados.consultado_em ?? dados.gerado_em).toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const opt = (v, rot, atual) => `<option value="${esc(v)}" ${atual === v ? "selected" : ""}>${esc(rot)}</option>`;
    alvo.innerHTML = `<div class="pos shp">
      <div class="pos-topo">
        <div class="pos-data">${icon("clock")}<span>Digisul data as of <strong>${esc(em)}</strong></span><span class="muted">· updated daily at 6:00, or now with Refresh · Order, Notes and Warehouse are saved for everyone as you type</span></div>
        <div class="pos-acoes">
          <button class="btn" id="shpImportar" title="Bring Order, Notes and Warehouse from the Shipment spreadsheet (.xlsx)">${icon("upload")}<span>Import spreadsheet</span></button>
          <button class="btn" id="shpExportar" title="Download what is on screen as an Excel file">${icon("download")}<span>Excel</span></button>
          <button class="btn" id="shpAtualizar" title="Fetch the latest data from Digisul now (updates it for everyone)">${icon("refresh")}<span>Refresh</span></button>
          <input type="file" id="shpArquivo" accept=".xlsx,.xlsm,.xls" hidden>
        </div>
      </div>
      ${erroEdicao ? `<div class="aviso-inline nota nota-alerta">${icon("alert")}<span>${esc(erroEdicao)}</span></div>` : ""}
      <div class="pos-filtros qa-filtros">
        <label class="busca sm">${icon("search")}<input type="search" id="shpBusca" placeholder="Contract, client, order or notes" value="${esc(filtros.busca)}" aria-label="Search"></label>
        <label class="qa-fil"><span>Branch</span><select id="shpFilial">${opt("", "All", filtros.filial)}${filiais.map((f) => opt(f, f, filtros.filial)).join("")}</select></label>
        <label class="qa-fil"><span>Shipment</span><select id="shpAte">${opt("next", "Up to next month", filtros.ate)}${opt("3", "Next 3 months", filtros.ate)}${opt("all", "All to ship", filtros.ate)}</select></label>
        <label class="qa-fil"><span>Service order</span><select id="shpSit">${opt("", "All", filtros.situacao)}${opt("none", "No order yet", filtros.situacao)}${opt("week", "Loading within 7 days, no order", filtros.situacao)}${opt("alert", "With alerts", filtros.situacao)}</select></label>
        <label class="qa-fil"><span>Client</span><select id="shpCli">${opt("", "All", filtros.cliente)}${clientes.map((c) => opt(c, c, filtros.cliente)).join("")}</select></label>
      </div>
      <div class="pos-kpis" id="shpKpis"></div>
      <section class="pos-card shp-card">
        <div class="shp-rolagem" id="shpTabela"></div>
      </section>
      <datalist id="shpGuiasL"></datalist><datalist id="shpLocaisL"></datalist>
    </div>`;
    preencherListas();
    desenharTabela();
    ligarEdicao(); // uma vez por desenho: a tabela troca, o contêiner fica

    $("#shpAtualizar", alvo).addEventListener("click", () => carregar(true));
    $("#shpExportar", alvo).addEventListener("click", exportar);
    $("#shpImportar", alvo).addEventListener("click", () => $("#shpArquivo", alvo).click());
    $("#shpArquivo", alvo).addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importar(f); });
    const ao = (id, k, guardar = true) => $(id, alvo).addEventListener("change", (e) => { filtros[k] = e.target.value; if (guardar) guardarFiltros(); if (k === "filial") filtros.cliente = ""; k === "filial" ? desenhar() : desenharTabela(); });
    ao("#shpFilial", "filial"); ao("#shpAte", "ate"); ao("#shpSit", "situacao"); ao("#shpCli", "cliente", false);
    // card clicado = mesmo filtro do "Service order"; clicar de novo (ou no total) mostra tudo
    $("#shpKpis", alvo).addEventListener("click", (e) => {
      const b = e.target.closest("[data-sit]");
      if (!b) return;
      filtros.situacao = b.dataset.sit === filtros.situacao ? "" : b.dataset.sit;
      $("#shpSit", alvo).value = filtros.situacao;
      guardarFiltros();
      desenharTabela();
    });
    let tmp;
    $("#shpBusca", alvo).addEventListener("input", (e) => { clearTimeout(tmp); tmp = setTimeout(() => { filtros.busca = e.target.value; desenharTabela(); }, 250); });
  }

  // sugestões ao digitar: guias abertas (e as recentes) e os armazéns conhecidos
  function preencherListas() {
    const guias = [...ix.guias.values()].map((l) => l[0]).filter(Boolean)
      .sort((a, b) => (!a.fechamento === !b.fechamento ? String(b.abertura).localeCompare(String(a.abertura)) : a.fechamento ? 1 : -1)).slice(0, 150);
    $("#shpGuiasL", alvo).innerHTML = guias.map((g) => `<option value="${esc(lerGuiaR(g.guia).base)}">${esc([g.fechamento ? t("closed") : t("open"), g.padrao, localCurto(g.armazem), g.servicos].filter(Boolean).join(" · "))}</option>`).join("")
      + SEM_GUIA.map((s) => `<option value="${esc(s)}"></option>`).join("");
    const locais = new Set([...dados.guias.map((g) => localCurto(g.armazem)), ...dados.exportacao.map((r) => localCurto(r.local)), ...[...edicoes.values()].map((e) => e.local?.trim())].filter((x) => x && x !== "-"));
    $("#shpLocaisL", alvo).innerHTML = [...locais].sort().map((l) => `<option value="${esc(l)}"></option>`).join("");
  }

  // informação da guia digitada (embaixo do campo)
  function infoGuia(a) {
    if (a.guia) {
      const g = a.guia;
      const lote = a.lotes[0];
      return `<span class="shp-gi">${g.fechamento ? `<span>Closed</span> ${esc(fmtData(g.fechamento))}` : `<span>Open</span>`} · ${esc(g.padrao ?? "")} · ${esc(localCurto(g.armazem) ?? "")}${
        lote ? ` · <span>lot</span> ${esc(lote.lote)} ${esc(fmtN(lote.sacas))} <span>bags</span> ${esc(lote.padrao ?? "")}${a.lotes.length > 1 ? ` +${a.lotes.length - 1}` : ""}` : ""}</span>`;
    }
    if (a.compra) {
      const c = a.compra;
      return `<span class="shp-gi" title="${esc(c.fornecedor ?? "")}">${esc(cortar(c.fornecedor ?? "", 28))} · ${esc(c.padrao ?? "")} · ${esc(fmtN(c.sacas))} <span>bags</span></span>`;
    }
    return "";
  }
  const cortar = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
  const celCheck = (a) => a.avisos.length
    ? a.avisos.map((x) => `<span class="tag tag-${x.nivel === "info" ? "info" : x.nivel}" title="${esc(x.txt)}">${icon(x.nivel === "info" ? "info" : "alert")}${esc(cortar(x.txt, 46))}</span>`).join("")
    : (a.guia || a.compra) ? `<span class="tag shp-ok">${icon("check")}OK</span>` : "";

  let visiveis = [];
  function desenharTabela() {
    // os cards contam sobre os demais filtros; o card escolhido só recorta a tabela
    const base = linhasFiltradas();
    const sit = SITUACOES[filtros.situacao];
    visiveis = sit ? base.filter(sit) : base;
    const sacasDe = (l) => l.reduce((s, x) => s + (x.r.sacas ?? 0), 0);
    const semGuia = base.filter(SITUACOES.none);
    const semana = base.filter(SITUACOES.week);
    const comAviso = base.filter(SITUACOES.alert);
    const kpi = (chave, tit, v, s, tom = "") => {
      const on = (filtros.situacao || "") === chave;
      return `<button type="button" class="pos-kpi ${tom ? `pos-kpi-${tom}` : ""} ${on ? "on" : ""}" data-sit="${chave}" aria-pressed="${on}"
        title="${esc(chave ? (on ? t("Click again to show all") : t("Click to show only these")) : t("Show all"))}">
        <span class="pos-kpi-t">${tom ? icon("alert") : ""}${esc(tit)}</span><span class="pos-kpi-v">${v}</span><span class="pos-kpi-s">${s}</span></button>`;
    };
    $("#shpKpis", alvo).innerHTML = `
      ${kpi("", "Contracts to ship", fmtN(base.length), `${fmtN(sacasDe(base))} ${t("bags")}`)}
      ${kpi("none", "No order yet", fmtN(semGuia.length), `${fmtN(sacasDe(semGuia))} ${t("bags")}`)}
      ${kpi("week", "Loading within 7 days, no order", fmtN(semana.length), t("contracts"), semana.length ? "alerta" : "")}
      ${kpi("alert", "Checks to look at", fmtN(comAviso.length), t("contracts"), comAviso.length ? "alerta" : "")}`;

    if (!visiveis.length) { $("#shpTabela", alvo).innerHTML = `<p class="muted qa-vazio">Nothing for this selection.</p>`; return; }
    $("#shpTabela", alvo).innerHTML = `<table class="shp-tab"><thead><tr>${COLS.map(([k, rot, tipo]) =>
      `<th class="${NUM.has(tipo) ? "num" : ""} ${tipo === "ed" ? "shp-ed-h" : ""} shp-c-${k}">${esc(rot)}</th>`).join("")}</tr></thead>
      <tbody>${visiveis.map(linhaHtml).join("")}</tbody>
      <tfoot><tr>${COLS.map(([k], i) => `<td class="${k === "sacas" || k === "peso" || k === "containers" ? "num" : ""} shp-c-${k}">${i === 0 ? "Total" : ["sacas", "peso", "containers"].includes(k) ? esc(fmtN(visiveis.reduce((s, x) => s + (x.r[k] ?? 0), 0))) : ""}</td>`).join("")}</tr></tfoot></table>`;
  }

  function linhaHtml({ r, a }) {
    const e = edicoes.get(r.contrato) ?? {};
    const quem = e.atualizado_em ? t("Changed by {p} {q}", { p: e.atualizado_por ?? "?", q: tempoRelativo(e.atualizado_em) }) : "";
    const atras = r.prev_carga && r.prev_carga < dados.hoje;
    return `<tr data-c="${esc(r.contrato)}" class="${atras ? "shp-atras" : ""}">${COLS.map(([k, , tipo]) => {
      if (tipo === "ed") {
        const campo = CAMPO[k];
        const lista = campo === "guia" ? "shpGuiasL" : campo === "local" ? "shpLocaisL" : "";
        const ph = campo === "local" && a.sugestao ? a.sugestao : "";
        return `<td class="shp-ed shp-c-${k}"><input class="shp-in" data-f="${campo}" value="${esc(e[campo] ?? "")}" ${lista ? `list="${lista}"` : ""}
          ${ph ? `placeholder="${esc(ph)}"` : ""} title="${esc(quem)}" aria-label="${esc(campo)} ${esc(r.contrato)}" autocomplete="off" spellcheck="false">
          ${campo === "guia" ? `<div class="shp-sub">${infoGuia(a)}</div>` : ""}
          ${campo === "local" && ph && semLocal(e.local) ? `<div class="shp-sub"><button type="button" class="link shp-usar" title="Use the warehouse from Digisul">${icon("check")}<span>Use</span> ${esc(ph)}</button></div>` : ""}</td>`;
      }
      if (tipo === "check") return `<td class="shp-check">${celCheck(a)}</td>`;
      const v = fmtCel(r[k], tipo);
      const longo = k === "qualidade" || k === "cliente";
      return `<td class="${NUM.has(tipo) ? "num" : ""} shp-c-${k}" ${longo && v ? `title="${esc(v)}"` : ""}>${esc(longo ? cortar(v, k === "cliente" ? 30 : 60) : v)}</td>`;
    }).join("")}</tr>`;
  }

  // atualiza só as células calculadas (os campos não perdem o foco)
  function reconferir() {
    const uso = usoDasGuias(dados.exportacao, edicoes, ix);
    for (const tr of $$("tbody tr[data-c]", alvo)) {
      const r = dados.exportacao.find((x) => x.contrato === tr.dataset.c);
      if (!r) continue;
      const a = analisar(r, edicoes.get(r.contrato), ix, { hoje: dados.hoje, uso });
      $(".shp-check", tr).innerHTML = celCheck(a);
      $(".shp-c-guia .shp-sub", tr).innerHTML = infoGuia(a);
      const loc = $('.shp-in[data-f="local"]', tr);
      loc.placeholder = a.sugestao ?? "";
      const tdLoc = loc.closest("td");
      $(".shp-sub", tdLoc)?.remove();
      if (a.sugestao && semLocal(loc.value))
        tdLoc.insertAdjacentHTML("beforeend", `<div class="shp-sub"><button type="button" class="link shp-usar" title="Use the warehouse from Digisul">${icon("check")}<span>Use</span> ${esc(a.sugestao)}</button></div>`);
    }
  }
  function usarSugestao(td) {
    const inp = $(".shp-in", td);
    inp.value = inp.placeholder;
    salvarLinha(inp.closest("tr"));
  }

  // ---------------------------------------------------------------- edição
  const limpo = (f, v) => { const s = String(v ?? "").trim().replace(/\s+/g, " "); return s ? (f === "guia" ? s.toUpperCase() : s) : null; };
  async function salvarLinha(tr) {
    const contrato = tr.dataset.c;
    const atual = edicoes.get(contrato) ?? {};
    const novo = { contrato };
    for (const inp of $$(".shp-in", tr)) novo[inp.dataset.f] = limpo(inp.dataset.f, inp.value);
    if (["guia", "obs", "local"].every((f) => (novo[f] ?? null) === (atual[f] ?? null))) return;
    const ins = $$(".shp-in", tr);
    ins.forEach((i) => i.classList.add("shp-salvando"));
    try {
      const [salvo] = await api.salvarShipment(novo);
      edicoes.set(contrato, salvo ?? { ...atual, ...novo });
      for (const inp of ins) {
        if (document.activeElement !== inp) inp.value = edicoes.get(contrato)[inp.dataset.f] ?? "";
        inp.title = t("Changed by {p} {q}", { p: edicoes.get(contrato).atualizado_por ?? "?", q: tempoRelativo(edicoes.get(contrato).atualizado_em) });
        inp.classList.remove("shp-erro");
        inp.classList.add("shp-salvo");
        setTimeout(() => inp.classList.remove("shp-salvo"), 1400);
      }
      reconferir();
    } catch (e) {
      ins.forEach((i) => { i.classList.add("shp-erro"); i.title = e.message; });
      toast(e.message, "erro");
    } finally {
      ins.forEach((i) => i.classList.remove("shp-salvando"));
    }
  }
  function ligarEdicao() {
    const tab = $("#shpTabela", alvo);
    tab.addEventListener("change", (e) => { if (e.target.matches(".shp-in")) salvarLinha(e.target.closest("tr")); });
    tab.addEventListener("keydown", (e) => {
      const inp = e.target;
      if (!inp.matches?.(".shp-in")) return;
      if (e.key === "Escape") { inp.value = edicoes.get(inp.closest("tr").dataset.c)?.[inp.dataset.f] ?? ""; inp.blur(); }
      // Enter (e as setas nas Notas, que não têm lista de sugestões): mesmo campo na linha
      // de baixo ou de cima; o "change" do campo que perde o foco salva
      const seta = (e.key === "ArrowDown" || e.key === "ArrowUp") && !inp.hasAttribute("list");
      if (e.key === "Enter" || seta) {
        e.preventDefault();
        const tr = e.key === "ArrowUp" ? inp.closest("tr").previousElementSibling : inp.closest("tr").nextElementSibling;
        const prox = tr && $(`.shp-in[data-f="${inp.dataset.f}"]`, tr);
        if (prox) { prox.focus(); prox.select(); } else inp.blur();
      }
    });
    tab.addEventListener("click", (e) => { const b = e.target.closest(".shp-usar"); if (b) usarSugestao(b.closest("td")); });
  }

  // ---------------------------------------------------------------- Excel
  async function exportar() {
    try {
      const XLSX = await carregarXlsx();
      const uso = usoDasGuias(dados.exportacao, edicoes, ix);
      const cab = COLS.map(([, rot]) => t(rot));
      const linhas = visiveis.map(({ r }) => {
        const e = edicoes.get(r.contrato) ?? {};
        const a = analisar(r, e, ix, { hoje: dados.hoje, uso });
        return COLS.map(([k, , tipo]) => {
          if (tipo === "ed") return e[CAMPO[k]] ?? "";
          if (tipo === "check") return a.avisos.map((x) => x.txt).join("; ");
          const v = r[k];
          if (v == null) return "";
          if ((tipo === "d" || tipo === "m") && ehData(v)) return new Date(v + "T12:00:00");
          return v;
        });
      });
      const ws = XLSX.utils.aoa_to_sheet([cab, ...linhas], { cellDates: true, dateNF: "dd/mm/yyyy" });
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: linhas.length, c: cab.length - 1 } }) };
      ws["!cols"] = COLS.map(([k]) => ({ wch: { cliente: 30, qualidade: 50, obs: 30, _check: 40 }[k] ?? 14 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Shipment");
      XLSX.writeFile(wb, `Shipment ${dados.hoje}.xlsx`);
    } catch (e) { toast(e.message, "erro"); }
  }

  // Importa GUIA / OBS / LOCAL da planilha antiga (procura a linha com "Contrato" e "GUIA")
  async function importar(file) {
    let lidas;
    try {
      const XLSX = await carregarXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellFormula: false, cellHTML: false, cellStyles: false });
      lidas = lerPlanilha(XLSX, wb);
    } catch (e) { toast(e.message, "erro"); return; }
    const mudam = lidas.filter((l) => ["guia", "obs", "local"].some((f) => (l[f] ?? null) !== (edicoes.get(l.contrato)?.[f] ?? null)));
    if (!mudam.length) { toast(t("Nothing to import: the spreadsheet matches what is saved.")); return; }
    const naTela = new Set(dados.exportacao.map((r) => r.contrato));
    const fora = mudam.filter((l) => !naTela.has(l.contrato)).length;
    const ok = await confirmar(t("Import spreadsheet"),
      esc(t("{n} contracts will get the Order, Notes and Warehouse from the spreadsheet, replacing what is saved for them.", { n: fmtN(mudam.length) }))
        + (fora ? `<br><span class="muted">${esc(t("{n} of them are not in the list to ship (already shipped or renamed in Digisul).", { n: fmtN(fora) }))}</span>` : ""),
      t("Import"));
    if (!ok) return;
    try {
      for (let i = 0; i < mudam.length; i += 200) {
        const salvos = await api.salvarShipment(mudam.slice(i, i + 200));
        for (const s of salvos ?? []) edicoes.set(s.contrato, s);
      }
      toast(t("{n} contracts imported.", { n: fmtN(mudam.length) }));
      erroEdicao = null;
      desenhar();
    } catch (e) { toast(e.message, "erro"); }
  }

  await carregar();
}

const somarDias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// linhas { contrato, guia, obs, local } da primeira aba que tiver as colunas Contrato e GUIA
export function lerPlanilha(XLSX, wb) {
  for (const nome of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: null });
    for (let i = 0; i < Math.min(g.length, 15); i++) {
      const cab = (g[i] ?? []).map(norm);
      const c = { contrato: cab.indexOf("CONTRATO"), guia: cab.indexOf("GUIA"), obs: cab.indexOf("OBS"), local: cab.indexOf("LOCAL") };
      if (c.contrato < 0 || c.guia < 0) continue;
      const txt = (v) => { const s = v == null ? "" : String(v).trim().replace(/\s+/g, " "); return s || null; };
      const out = new Map();
      for (const l of g.slice(i + 1)) {
        const contrato = txt(l?.[c.contrato]);
        if (!contrato || !/^[A-Z]{2,5}-\d/i.test(contrato)) continue;
        out.set(contrato.toUpperCase(), {
          contrato: contrato.toUpperCase(),
          guia: txt(l[c.guia])?.toUpperCase() ?? null,
          obs: c.obs >= 0 ? txt(l[c.obs]) : null,
          local: c.local >= 0 ? txt(l[c.local]) : null,
        });
      }
      if (out.size) return [...out.values()];
    }
  }
  throw new Error(t("No sheet with the Contrato and GUIA columns was found in this file."));
}
