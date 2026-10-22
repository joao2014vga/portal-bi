// Position: cálculo sem tela, usado pelo portal (navegador) e pela sincronização
// automática (servidor). Não depende de DOM.
//
// Dois caminhos chegam ao mesmo resultado { data_ref, resumo, detalhes }:
//   1. planilha enviada: as abas de resumo já vêm calculadas pelo Excel;
//   2. API do Digisul: as abas base (Purchases, ExpSales, IntSales, Inventory) são
//      remontadas a partir das consultas, e as fórmulas da própria planilha (o "modelo",
//      guardado no último upload) são executadas aqui por um avaliador de fórmulas.
//      Os futuros (OpenFutures) não existem na API e vêm do último upload.

// =====================================================================
// LEITURA DAS ABAS (grade = matriz [linha][coluna] a partir de A1)
// =====================================================================
export const ABAS = {
  termm: "Position Overview TermM", fisica: "Physical Position", variacao: "Variation",
  purchases: "Purchases", expsales: "ExpSales", intsales: "IntSales", inventory: "Inventory",
};
// abas de resumo (fórmulas executadas no modo API) e abas base
const ABAS_CALCULO = [ABAS.termm, ABAS.fisica, ABAS.variacao];
const ABAS_BASE = [ABAS.purchases, ABAS.expsales, ABAS.intsales, ABAS.inventory, "OpenFutures"];

export const norm = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const arred = (v) => Math.round(v * 100) / 100;
const vazia = (l) => l.every((v) => v == null || String(v).trim() === "");
// datas do Excel chegam como número de série (dias desde 30/12/1899)
const SERIAL0 = Date.UTC(1899, 11, 30);
// (data com hora, como a Data de Inclusão, fica no próprio dia — não arredonda para o seguinte)
export const serialIso = (n) => new Date(SERIAL0 + Math.floor(n + 1e-6) * 864e5).toISOString().slice(0, 10);
const isoSerial = (iso) => Math.round((Date.parse(iso.slice(0, 10)) - SERIAL0) / 864e5);
// data de hoje em São Paulo (o servidor roda em UTC)
export const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

// Blocos achados pelo título (não pela linha), para aguentar linhas inseridas.
const GRUPOS = [["arabica", /^ARABICA/], ["robusta", /^ROBUSTA/], ["exportable", /^EXPORTABLE/], ["lowgrade", /^LOW GRADE/]];

// Position Overview TermM: colunas B..R de cada bloco
export const COLS_TERMM = ["cash", "purchases", "purchases_fixed", "purchases_ptbf", "inventory", "sales", "exp_sales", "exp_fixed",
  "exp_ptbf", "int_sales", "int_fixed", "int_ptbf", "futures", "futures_ptbf", "switch_exp", "net_diff", "net_outright"];

export function lerTermM(g) {
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
export function lerFisica(g) {
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
const NOMES_VARIACAO = { ARABICA: "arabica", CONILON: "robusta", EXP: "exportable", "LOW GRADE": "lowgrade" };
export function lerVariacao(g) {
  const out = {};
  for (let i = 0; i < g.length; i++) {
    for (let c = 0; c < g[i].length; c++) {
      const chave = NOMES_VARIACAO[norm(g[i][c])];
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
export const DETALHES = {
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
      ["data_bl", "Data BL", "d"], ["safra", "Safras"], ["padrao", "Padrão"], ["peneira", "Peneira"], ["grupo", "Quality Group"], ["especie", "Espécie"],
      ["bolsa", "Bolsa"], ["unidade", "Unidade"], ["diferencial", "Diferencial", "n"], ["vlr_final", "Vlr. Final", "n"],
      ["valor_usd", "Valor Contrato (US$)", "n"], ["saldo", "Saldo (sc)", "n"], ["prev_carga", "Prev. Carga", "d"], ["embarque", "Embarque", "d"],
      // painel de diferenciais médios: por data de inclusão ou por mês de embarque (EOM Ship)
      ["inclusao", "Data de Inclusão", "d"], ["eom_ship", "EOM Ship", "d"]],
    // realizadas (com BL) e as que ainda têm saldo a embarcar
    aberto: (r) => !!r.data_bl || r.saldo > 0,
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

export function lerDetalhe(g, def) {
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

// Resumo e contratos a partir das grades das abas (mesma leitura nos dois caminhos)
export function montarPosition(gAba) {
  const gTermM = gAba(ABAS.termm);
  const serial = num(gTermM[0]?.[0]);
  if (serial == null) throw new Error(`"${ABAS.termm}": the "updated as of" date in cell A1 was not found.`);
  const termm = lerTermM(gTermM);
  const resumo = {
    versao: 1,
    termm,
    fisica: lerFisica(gAba(ABAS.fisica)),
    variacao: lerVariacao(gAba(ABAS.variacao)),
    kpis: Object.fromEntries(Object.entries(termm).map(([k, b]) => [k, { diff: b.total.net_diff, outright: b.total.net_outright }])),
  };
  const detalhes = Object.fromEntries(Object.entries(DETALHES).map(([k, def]) => [k, lerDetalhe(gAba(def.aba), def)]));
  return { data_ref: serialIso(serial), resumo, detalhes };
}

// =====================================================================
// PRAZO DE FIXAÇÃO
// =====================================================================
// Prazo de fixação = First Notice Day (FND) estimado do mês da bolsa:
// N dias úteis antes do 1º dia útil do mês (feriados não considerados).
// NY (Coffee "C"): 7 dias úteis · Londres (Robusta): 4 · outras bolsas: 1º dia útil do mês.
const DIAS_FND = { NY: 7, "NEW YORK": 7, LONDRES: 4, LONDON: 4, LDN: 4 };
export const ALERTA_DIAS = 15, AVISO_DIAS = 30;

function primeiroAviso(mesIso, bolsa) {
  const d = new Date(`${mesIso.slice(0, 7)}-01T12:00:00Z`);
  const util = () => d.getUTCDay() % 6 !== 0;
  while (!util()) d.setUTCDate(d.getUTCDate() + 1);
  for (let n = DIAS_FND[norm(bolsa)] ?? 0; n > 0;) { d.setUTCDate(d.getUTCDate() - 1); if (util()) n--; }
  return d.toISOString().slice(0, 10);
}
const diasAte = (iso) => Math.round((new Date(iso + "T12:00:00Z") - new Date(hojeSP() + "T12:00:00Z")) / 864e5);

// mês da bolsa de cada tipo de contrato
export const CAMPO_MES = { purchases: "mes_bolsa", expsales: "fixar_mes", intsales: "fixar_mes" };

// Situação de fixação de um contrato com lotes a fixar (null quando não há o que fixar)
export function prazoFixacao(r, tipo) {
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

// Texto da notificação (null quando não há nada vencido ou em até 15 dias).
// fmtN: formatação dos números no idioma do portal.
export function textoAlertaFixacao(detalhes, fmtN = (v, d = 0) => v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })) {
  const a = alertasFixacao(detalhes);
  const lotes = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? fmtN(Math.round(v)) : fmtN(v, 1));
  const partes = [];
  if (a.vencido.c) partes.push(`${a.vencido.c} ${a.vencido.c === 1 ? "contract" : "contracts"} (${lotes(a.vencido.l)} lots) past the first notice day`);
  if (a.urgente.c) partes.push(`${a.urgente.c} ${a.urgente.c === 1 ? "contract" : "contracts"} (${lotes(a.urgente.l)} lots) due within ${ALERTA_DIAS} days`);
  return partes.length ? `Lots to fix: ${partes.join(" · ")}` : null;
}

// =====================================================================
// PTAX (receita em R$ das vendas de exportação)
// =====================================================================
// PTAX de compra do dia útil anterior ao BL (D-1, a mesma referência da tela de Payments).
const PTAX_URL = (ini, fim) => "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo("
  + `dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${ini}'&@dataFinalCotacao='${fim}'`
  + "&$top=10000&$format=json&$select=cotacaoCompra,dataHoraCotacao";
const dataBcb = (iso) => `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;

export async function aplicarPtax(vendas) {
  const datas = vendas.map((r) => r.data_bl).filter(Boolean).sort();
  if (!datas.length) return 0;
  const ini = new Date(`${datas[0]}T12:00:00Z`);
  ini.setUTCDate(ini.getUTCDate() - 10);
  const res = await fetch(PTAX_URL(dataBcb(ini.toISOString().slice(0, 10)), dataBcb(hojeSP())));
  if (!res.ok) throw new Error(`PTAX ${res.status}`);
  // uma cotação de fechamento por dia, em ordem de data
  const cot = (await res.json()).value.map((c) => [c.dataHoraCotacao.slice(0, 10), c.cotacaoCompra]).sort((a, b) => a[0].localeCompare(b[0]));
  let semPtax = 0;
  for (const r of vendas) {
    if (!r.data_bl) continue;
    // última cotação estritamente antes da data do BL (busca binária)
    let lo = 0, hi = cot.length - 1, achou = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cot[m][0] < r.data_bl) { achou = m; lo = m + 1; } else hi = m - 1; }
    if (achou >= 0) { r.ptax = cot[achou][1]; r.ptax_data = cot[achou][0]; } else semPtax++;
  }
  return semPtax;
}

// =====================================================================
// DIGISUL → COLUNAS DAS ABAS BASE
// =====================================================================
// As consultas da API não são as mesmas telas que geram a planilha: nomes, formatos e
// algumas regras diferem. Cada função devolve uma linha com os títulos exatos da aba.
// Regras conferidas contra a planilha de 21/10/2026 (diferenças restantes = movimentos do dia).
const MESES = { JAN: 1, FEV: 2, FEB: 2, MAR: 3, ABR: 4, APR: 4, MAI: 5, MAY: 5, JUN: 6, JUL: 7, AGO: 8, AUG: 8,
  SET: 9, SEP: 9, OUT: 10, OCT: 10, NOV: 11, DEZ: 12, DEC: 12 };
const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - SERIAL0) / 864e5);
// "2026-10-16T00:00:00.000Z" | "2026-10-16" | "31/10/2027" → número de série
function data(v) {
  const s = String(v ?? "").trim();
  let m;
  if ((m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s))) return serial(+m[1], +m[2], +m[3]);
  if ((m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(s))) return serial(+m[3], +m[2], +m[1]);
  return null;
}
const dataHora = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : (t - SERIAL0) / 864e5; };
// "Jun/2024" | "Nov 2027" → 1º dia do mês
function mes(v) {
  const m = /^([A-Za-z]{3})[/ ](\d{4})$/.exec(String(v ?? "").trim());
  return m && MESES[m[1].toUpperCase()] ? serial(+m[2], MESES[m[1].toUpperCase()], 1) : null;
}
const n = (v) => (v == null || v === "" ? null : Number(v));
const z = (v) => n(v) ?? 0;
// a consulta de estoque devolve números como texto no formato "1,234.56"
const nt = (v) => (v == null || v === "" ? null : typeof v === "number" ? v : Number(String(v).replace(/,/g, "")));
const zt = (v) => nt(v) ?? 0;
const t = (v) => (v == null || String(v).trim() === "" ? null : String(v).replace(/[\r\n]/g, "").trim());
// a tela de exportação dobra o apóstrofo nos textos livres
const tq = (v) => t(v)?.replace(/'/g, "''") ?? null;
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const SACAS_LOTE = { NY: 283.5, LONDRES: 500 / 3 };
const sacasLote = (bolsa) => SACAS_LOTE[norm(bolsa)] ?? null;

function expSales(a) {
  const ton = a.Unidade === "$/Ton.";
  let qf = r2(z(a["Qtd Fixada(sc)"])), qaf = r2(z(a["Qtd a Fixar(sc)"])), ql = z(a["Qtd Lotes"]), lf = z(a["Lotes Fixado"]);
  // totalmente fixado mas a consulta não traz a quantidade fixada: a tela considera o contrato inteiro
  if (a["Status Fixacao"] === "Totalmente Fixado" && qf === 0) {
    qf = r2(z(a.Sacas)); qaf = 0;
    const lote = sacasLote(a.Bolsa);
    ql = lf = lote ? Math.round(qf / lote) : 0;
  }
  return {
    "Contrato": t(a.Contrato), "Importador": t(a.Importador), "Embarque": mes(a.Embarque), "Qz": t(a.Qz),
    "Sacas": r2(z(a.Sacas)), "Qtd. Fixada (sc)": qf, "Qtd. a Fixar (sc)": qaf, "Peso": z(a.Peso),
    "Qtd. Lotes": ql, "Lotes Fixado": lf, "Lotes a Fixar": z(a["Lotes a Fixar"]), "Status Fixação": t(a["Status Fixacao"]),
    "Preço": t(a.Preco), "Bolsa": t(a.Bolsa), "Diferencial": n(a.Diferencial), "Vlr. Fixado": n(a["Vlr Fixado"]),
    // contratos em $/Ton vêm da consulta multiplicados por 100
    "Vlr. Final": ton ? z(a["Vlr Final"]) / 100 : n(a["Vlr Final"]),
    "Comissão US$Cts/Lb": n(a["Comissao USD Cts Lb"]), "Dif. + Comis.": n(a.DifComis), "Unidade": t(a.Unidade),
    "Opção de Fixação": t(a["Opcao de Fixacao"]), "Dias a Fixar": n(a["Dias a fixar"]), "Fixar Mês": mes(a["Fixar Mes"]),
    "Fixação": data(a.Fixacao), "Qualidade": tq(a.Qualidade), "Padrão": t(a.Padrao), "Peneira": t(a.Peneira),
    "Referência": t(a.nom_ref_cli), "Prev. Carga": data(a["Prev Carga"]), "Data Saída": data(a.Data_Saida),
    "Saída (sc)": Math.round(z(a.Saida_sc)), "Devolução": z(a.Devolucao),
    "Saldo (sc)": Math.round(z(a.Sacas) - z(a.Saida_sc) + z(a.Devolucao)),
    "Certificação": t(a["ifnull(A.Certificador,'')"]), "Emissão": data(a.Emissao), "Data BL": data(a.Data_BL),
    "Safras": t(a.Safras), "Qtd. Embalagem (Vol.)": n(a.Qtd_Embalagem_Vol), "Incoterm": t(a.Incoterm),
    "Condição": t(a.Condicao), "Alertas": tq(a.Alertas),
    // a tela calcula pelo peso faturado; o valor de registro bate em ~86% (o portal só usa sem preço)
    "Valor Contrato (US$)": r2(z(a.Vlr_Registro)), "Espécie": t(a.Especie), "Data de Inclusão": dataHora(a.Data_Inclusao),
  };
}

function purchases(a) {
  const aFixar = a.Fixacao === "A Fixar";
  const sacasT = r2(z(a.Sacas_Total_BC ?? a["Sacas Total"]));
  // entrega lançada direto como lote na filial: a consulta não soma em "Entregue", a tela sim
  const entregaPorLote = z(a.Entregue_sc) === 0 && !!a.Filial_do_Lote;
  const entregue = entregaPorLote ? sacasT : r2(z(a.Entregue_sc));
  const aEntregar = entregaPorLote ? 0 : r2(z(a.A_Entregar_BC));
  let qf, qaf, ql, lf, laf, status = null;
  if (aFixar) {
    qf = r2(z(a.Qtd_Fixada));
    qaf = r2(sacasT - qf);
    ql = z(a.Qtd_Lotes);
    lf = z(a.Lotes_Fixado);
    laf = a.Lotes_a_Fixar == null ? r4(ql - lf) : z(a.Lotes_a_Fixar);
    status = a.Status_Fixacao === "Totalmente Fixado" ? "Totalmente Fixado" : qf > 0 ? "Parcialmente Fixado" : "Pendente de Fixação";
  } else {
    // preço fixo: a tela traz o saldo a entregar como "fixado" enquanto houver saldo
    qf = aEntregar !== 0 ? aEntregar : r2(z(a.Qtd_Fixada));
    qaf = 0;
    const lote = sacasLote(a.Bolsa);
    ql = lf = lote ? Math.round(qf / lote) : 0;
    laf = 0;
  }
  return {
    "Contrato": t(a.Contrato), "Fornecedor": t(a.Fornecedor), "Modalidade CTR": t(a.Modalidade_CTR),
    "Sacas": r2(z(a.Compra_BC_sc ?? a.Sacas)), "Ajuste Total": r2(z(a["Ajuste Total"])), "Sacas Total": sacasT,
    "Emissão": data(a.Emissao), "Vencimento": data(a.Vencimento),
    "Ajustes (R$)": r2(z(a.Ajustes_Reais)),
    // a consulta arredonda "Sacas Total"; quando isso muda a média, recalcula pelo total em BC
    "Média Final (R$)": Math.abs(z(a["Sacas Total"]) - sacasT) < 0.01 ? r2(z(a.Media_Final_Reais))
      : sacasT ? r2(z(a.Valor_Final_Reais) / sacasT) : 0,
    "Valor Final (R$)": r2(z(a.Valor_Final_Reais)), "Pago (R$)": r2(z(a.Pago_Reais)),
    "Outras Desp. (R$)": r2(z(a.Outras_Desp_Reais)), "A Pagar (R$)": r2(z(a.A_Pagar_Reais)),
    "Entregue(Sc)": entregue, "A Entregar BC": aEntregar, "Referência": t(a.Referencia),
    // depois da entrega a tela mostra a data real no lugar da previsão
    "Prev. de Entrega": data(a.Entrega) ?? data(a.Prev_de_Entrega), "% 17/18": z(a.Perc_Pen_17), "% Quebra": z(a.Perc_Quebra),
    "Padrão": t(a.Padrao), "Bebida": t(a.Bebida), "Peneira": t(a.Peneira), "% Grinder": z(a.Perc_Grinder),
    "Fixação": t(a.Fixacao), "Fixador": t(a.Fixador), "Status Fixação": status, "Bolsa": t(a.Bolsa),
    "Mês Bolsa": mes(a.Mes_Bolsa), "Diferencial": n(a.Diferencial), "Data Fixação": data(a.Data_Fixacao),
    "Qtd. Fixada": qf, "Qtd, a Fixar": qaf, "Qtd. Lotes": ql, "Lotes Fixado": lf, "Lotes a Fixar": laf,
    "Certificador": t(a.Certificador), "Espécie": t(a.Especie), "Bica Corrida": t(a["Bica Corrida"]),
    "Futuro": data(a.Futuro), "Devoluções (sc)": z(a.Devoluoes_sc), "Safra": t(a.Safra),
  };
}

function intSales(a) {
  const aFixar = a.Fixacao === "A Fixar";
  const aEntregar = r2(z(a["A Entregar(Sc)"]));
  let qf, qaf, ql, lf, laf, status = null;
  if (aFixar) {
    qf = r2(z(a["Qtd Fixada"]));
    qaf = r2(z(a["Qtd a fixar"]));
    ql = z(a["Qtd lotes"]);
    lf = z(a["Lotes Fixado"]);
    laf = a["Lotes a fixar"] == null ? r4(ql - lf) : z(a["Lotes a fixar"]);
    status = laf > 0 ? (lf > 0 ? "Parcialmente Fixado" : "Pendente de Fixação") : "Totalmente Fixado";
  } else {
    // preço fixo: como nas compras, o saldo a entregar aparece como "fixado"; lotes sem arredondar
    qf = aEntregar > 0 ? aEntregar : r2(z(a["Qtd Fixada"]));
    qaf = 0;
    ql = lf = r4(qf / (sacasLote(a.Bolsa) ?? SACAS_LOTE.NY));
    laf = 0;
  }
  const x100 = (v) => (v == null ? null : r4(v * 100));
  return {
    // a tela escapa a barra invertida dos contratos desmembrados ("BRV-0002/24\\A")
    "Contrato": t(a.Contrato)?.replace(/\\/g, "\\\\") ?? null,
    "Emissão": data(a.Emissao), "Referência": t(a.Referencia), "Cliente": t(a.Cliente),
    "Sacas": r2(z(a.Sacas)), "Ajustes": r2(z(a.Ajustes)), "Sacas Total": r2(z(a["Sacas Total"])), "Entregue": r2(z(a.Entregue)),
    "Devolvido": r2(z(a.Devolvido)), "A Entregar(Sc)": aEntregar, "A Entregar(Kg)": z(a["A Entregar(Kg)"]),
    "Unitário R$": r2(z(a["Unitario Reais"])), "Total Venda R$": r2(z(a.valortotal)), "Entregue R$": r2(z(a["Entregue Reais"])),
    "Saldo R$": r2(z(a["Saldo Reais"])),
    // a tela soma o ICMS ao valor a receber; a consulta não traz o imposto
    "A Receber (R$)": r2(z(a.valortotal) - z(a["Recebido reais"])),
    "Recebido (R$)": r2(z(a["Recebido reais"])), "Data Saída": data(a["Data Saida"]), "Custos R$": r2(z(a["Custos Reais"])),
    "Fixação": t(a.Fixacao), "Fixador": t(a.Fixador), "Status Fixação": status, "Bolsa": t(a.Bolsa),
    "Fixar Mês": mes(a["Fixar Mes"]),
    // diferencial, valor fixado e mercado vêm da consulta divididos por 100
    "Diferencial": x100(a.Diferencial), "Data Fixação": data(a["Data Fixacao"]), "Valor Fixado": x100(a["Valor Fixado"]),
    "Mercado US$": a["Mercado Dolar"] == null ? null : a["Mercado Dolar"] * 100,
    "Qtd. Fixada": qf, "Qtd, a Fixar": qaf, "Qtd. Lotes": ql, "Lotes Fixado": lf, "Lotes a Fixar": laf,
    "Padrão": t(a.Padrao), "% Quebra": z(a["Perc Quebra"]), "% Grinder": z(a["Perc Grinder"]),
    "1° Vencimento": data(a["Primeiro Vencimento"]), "Prev. Embarque": data(a["Prev Embarque"]), "Peneira": t(a.Peneira),
    "Modalidade CTR": t(a["Modalidade CTR"]), "Peso Padrão(Sc)": z(a["Peso Padrao Sc"]), "Espécie": t(a.Especie),
    "Futuro": data(a.Futuro), "Safra": t(a.Safra),
  };
}

function inventory(a) {
  const doc = String(a.Doc_Origem ?? "");
  return {
    "Lote/Guia": t(a.Lote_Guia), "Tipo": t(a.Tipo), "Peso": zt(a.Peso), "Peneiras": t(a.Peneiras), "Bebida": t(a.Bebida),
    "Padrão": t(a.Padrao), "Contrato": t(a.Contrato), "% Quebra": zt(a.Per_Quebra), "Custo R$": zt(a.Custo_Reais),
    "Aprovado": t(a.Aprovado), "Safra": t(a.Safra), "Filial": t(a.Filial), "% Grinder": zt(a.Per_Grinder),
    "Catado": zt(a.Catado), "Consumo": zt(a.Consumo), "Espécie": t(a.Especie), "Peso Padrão(Sc)": zt(a["Peso Padrao_Sc"]),
    "Armazém": t(a.Armazem), "Certificador": t(a.Certificador), "% Pen 17": zt(a.Per_Pen_17),
    "Guia de Serviço": /^Guia de Servi.o /i.test(doc) ? doc.replace(/^Guia de Servi.o /i, "").trim() : null,
    "Data Entrada": data(a.data_lote),
    "% GTLB": zt(a.Perc_LTGB), "% MTGB": zt(a.Perc_MTGB), "% MOKA": zt(a.Perc_MOKA), "% GRINDER": zt(a.Perc_GRINDER), "% LG": zt(a.Perc_LG),
  };
}

// consultas do Digisul usadas e a aba que cada uma alimenta
export const CONSULTAS = {
  compras: { idsql: 11, aba: ABAS.purchases, linha: purchases, chave: "Contrato" },
  exportacao: { idsql: 6, aba: ABAS.expsales, linha: expSales, chave: "Contrato" },
  vendas_interno: { idsql: 3, aba: ABAS.intsales, linha: intSales, chave: "Contrato" },
  estoque: { idsql: 8, aba: ABAS.inventory, linha: inventory, chave: "Lote/Guia" },
};
export const paramsConsulta = (nome) => ({
  compras: { EMPRESA: "1", FILIAIS: "1,2,3", DATAINI: "01/01/2000", DATAFIM: "31/12/2099" },
  exportacao: { EMPRESA: "1" },
  vendas_interno: { EMPRESA: "1", FILIAIS: "1,2,3" },
  estoque: { EMPRESA: "1", FILIAIS: "1,2,3" },
}[nome]);

// =====================================================================
// AVALIADOR DE FÓRMULAS (o subconjunto do Excel usado pela planilha)
// =====================================================================
// SUMIFS, COUNTIFS, SUM, AVERAGE, ROUND, IF, IFS, IFERROR, EOMONTH, XLOOKUP, operadores.
class ErroXL { constructor(c) { this.c = c; } }
const NA = new ErroXL("#N/A"), VALOR = new ErroXL("#VALUE!"), DIV0 = new ErroXL("#DIV/0!"), REF = new ErroXL("#REF!"), NOME = new ErroXL("#NAME?");
const ehErro = (v) => v instanceof ErroXL;

const colNum = (s) => { let x = 0; for (const ch of s) x = x * 26 + ch.charCodeAt(0) - 64; return x; };
export const colLetra = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function tokenizar(f) {
  const tk = [];
  let i = 0;
  const resto = () => f.slice(i);
  while (i < f.length) {
    const c = f[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    if (c === '"') { m = /^"((?:[^"]|"")*)"/.exec(resto()); tk.push({ t: "str", v: m[1].replace(/""/g, '"') }); i += m[0].length; continue; }
    if ((m = /^#(?:REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.exec(resto()))) { tk.push({ t: "err", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(resto()))) { tk.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
    // referência: [aba!]A1 | [aba!]A1:B2 | [aba!]A:B
    if ((m = /^(?:'((?:[^']|'')+)'!|([A-Za-z_][\w.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)?(?::(\$?)([A-Z]{1,3})(\$?)(\d+)?)?(?![\w(])/.exec(resto()))
      && (m[6] || m[10] || m[8])) {
      const aba = m[1] ? m[1].replace(/''/g, "'") : m[2] ?? null;
      const a = { c: colNum(m[4]), r: m[6] ? +m[6] : null, ac: !!m[3], ar: !!m[5] };
      if (m[8]) {
        const b = { c: colNum(m[8]), r: m[10] ? +m[10] : null, ac: !!m[7], ar: !!m[9] };
        tk.push({ t: "rng", aba, a, b });
      } else tk.push({ t: "ref", aba, ...a });
      i += m[0].length; continue;
    }
    if ((m = /^([A-Z][A-Z0-9.]*)\(/.exec(resto()))) { tk.push({ t: "fn", v: m[1] }); i += m[1].length; continue; }
    if ((m = /^(TRUE|FALSE)(?![\w(])/.exec(resto()))) { tk.push({ t: "bool", v: m[1] === "TRUE" }); i += m[0].length; continue; }
    if ((m = /^(<>|<=|>=|[-+*/^&=<>(),:%])/.exec(resto()))) { tk.push({ t: "op", v: m[1] }); i += m[1].length; continue; }
    throw new Error(`formula token not understood: ${resto().slice(0, 20)}`);
  }
  return tk;
}

// Análise sintática por precedência: comparação < & < + - < * / < ^ < unário
function analisar(f) {
  const tk = tokenizar(f.replace(/^=/, ""));
  let p = 0;
  const ve = () => tk[p], op = (v) => tk[p]?.t === "op" && tk[p].v === v;
  const espera = (v) => { if (!op(v)) throw new Error(`"${v}" expected in ${f}`); p++; };
  const bin = (prox, ops) => () => {
    let a = prox();
    while (tk[p]?.t === "op" && ops.includes(tk[p].v)) { const o = tk[p++].v; a = { k: "bin", o, a, b: prox() }; }
    return a;
  };
  const prim = () => {
    const x = tk[p++];
    if (!x) throw new Error(`incomplete formula: ${f}`);
    if (x.t === "num") return { k: "val", v: x.v };
    if (x.t === "str") return { k: "val", v: x.v };
    if (x.t === "bool") return { k: "val", v: x.v };
    if (x.t === "err") return { k: "val", v: x.v === "#REF!" ? REF : NA };
    if (x.t === "ref") return { k: "ref", ...x };
    if (x.t === "rng") return { k: "rng", ...x };
    if (x.t === "op" && x.v === "(") { const e = comp(); espera(")"); return e; }
    if (x.t === "op" && (x.v === "-" || x.v === "+")) { const e = pot(); return x.v === "-" ? { k: "neg", a: e } : e; }
    if (x.t === "fn") {
      espera("(");
      const args = [];
      if (!op(")")) { do { args.push(op(",") || op(")") ? { k: "val", v: null } : comp()); } while (op(",") && ++p); }
      espera(")");
      return { k: "fn", n: x.v, args };
    }
    throw new Error(`unexpected "${x.v}" in ${f}`);
  };
  const pot = bin(prim, ["^"]);
  const mult = bin(pot, ["*", "/"]);
  const soma = bin(mult, ["+", "-"]);
  const conc = bin(soma, ["&"]);
  const comp = bin(conc, ["=", "<>", "<", ">", "<=", ">="]);
  const e = comp();
  if (p < tk.length) throw new Error(`unexpected "${ve().v}" in ${f}`);
  return e;
}

// coerções do Excel
const paraNum = (v) => {
  if (ehErro(v)) return v;
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const x = Number(String(v).trim());
  return String(v).trim() !== "" && Number.isFinite(x) ? x : VALOR;
};
const paraTexto = (v) => (v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
const textoIgual = (a, b) => paraTexto(a).toUpperCase() === paraTexto(b).toUpperCase();
function comparar(a, b) {
  // vazio vira 0 ou "" conforme o outro lado; número < texto < lógico
  if (a == null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b == null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ord = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  if (ord(a) !== ord(b)) return ord(a) - ord(b);
  if (typeof a === "string") { const x = a.toUpperCase(), y = b.toUpperCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}
const arredExcel = (x, d) => { const f = 10 ** d; return Math.sign(x) * Math.round(Math.abs(x) * f * (1 + Number.EPSILON)) / f; };
function eomonth(s, m) {
  const d = new Date(SERIAL0 + Math.floor(s) * 864e5);
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + m, 0) - SERIAL0) / 864e5);
}

// critério de SUMIFS/COUNTIFS → função de teste de uma célula
function criterio(c) {
  if (c == null) c = 0; // referência a célula vazia vale 0
  if (typeof c === "number") return (v) => typeof v === "number" && v === c;
  if (typeof c === "boolean") return (v) => v === c;
  const s = String(c);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(s);
  const o = m[1] ?? "=", x = m[2];
  const xn = x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null;
  if (xn != null) {
    const cmp = { "=": (a) => a === xn, "<>": (a) => a !== xn, "<": (a) => a < xn, ">": (a) => a > xn, "<=": (a) => a <= xn, ">=": (a) => a >= xn }[o];
    return o === "<>" ? (v) => typeof v !== "number" || cmp(v) : (v) => typeof v === "number" && cmp(v);
  }
  if (x === "") return o === "<>" ? (v) => v != null && v !== "" : o === "=" ? (v) => v == null || v === "" : () => false;
  const X = x.toUpperCase();
  if (o === "=" || o === "<>") {
    const re = /[*?]/.test(x) ? new RegExp(`^${X.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s") : null;
    const igual = (v) => typeof v === "string" && (re ? re.test(v.toUpperCase()) : v.toUpperCase() === X);
    return o === "=" ? igual : (v) => !igual(v);
  }
  const cmp = { "<": (a) => a < X, ">": (a) => a > X, "<=": (a) => a <= X, ">=": (a) => a >= X }[o];
  return (v) => typeof v === "string" && cmp(v.toUpperCase());
}

// Pasta de trabalho: abas de resumo (células com fórmula ou valor) e abas base (colunas)
class Pasta {
  constructor(modelo, bases, sobrepor = {}) {
    this.calc = new Map(); // aba → Map("A1" → {f|v})
    for (const [aba, cel] of Object.entries(modelo.abas)) this.calc.set(aba, new Map(Object.entries(cel)));
    for (const [aba, cel] of Object.entries(sobrepor)) for (const [a, v] of Object.entries(cel)) this.calc.get(aba)?.set(a, { v });
    this.memo = new Map();
    this.ast = new Map();
    this.base = new Map(); // aba → { n, cols: Map(c → array 1..n), formulas: Map(c → texto) }
    for (const [aba, def] of Object.entries(modelo.bases)) {
      const linhas = bases[aba] ?? [];
      const cols = new Map();
      const formulas = new Map();
      for (const [L, titulo] of Object.entries(def.cabecalho)) {
        const c = colNum(L);
        if (def.formulas?.[L]) { formulas.set(c, def.formulas[L]); continue; }
        const nome = titulo.trim();
        cols.set(c, [titulo, ...linhas.map((r) => r[nome] ?? null)]);
      }
      this.base.set(aba, { n: linhas.length + 1, cols, formulas, titulos: def.cabecalho });
    }
    // List: tabela fixa de padrões → grupo (e o que mais a planilha consultar ali)
    const lista = new Map();
    for (const [L, valores] of Object.entries(modelo.lista ?? {})) lista.set(colNum(L), valores);
    this.base.set("List", { n: Math.max(0, ...[...lista.values()].map((v) => v.length)), cols: lista, formulas: new Map(), titulos: {} });
    this.mascaras = new Map();
    this.rangos = new Map();
  }
  arvore(f) { let a = this.ast.get(f); if (!a) this.ast.set(f, (a = analisar(f))); return a; }

  // coluna inteira de uma aba base (fórmulas cinzas calculadas linha a linha)
  coluna(aba, c) {
    const b = this.base.get(aba);
    if (!b) return null;
    let col = b.cols.get(c);
    if (col) return col;
    const f = b.formulas.get(c);
    col = new Array(b.n).fill(null);
    if (f) {
      col[0] = b.titulos[colLetra(c)] ?? null;
      b.cols.set(c, col); // evita recursão infinita em referência circular
      const ast = this.arvore(f);
      for (let r = 2; r <= b.n; r++) col[r - 1] = this.valor(this.eval(ast, aba, r - 2));
    } else b.cols.set(c, col);
    return col;
  }
  celula(aba, c, r) {
    if (this.base.has(aba)) { const col = this.coluna(aba, c); return r <= col.length ? col[r - 1] : null; }
    const cel = this.calc.get(aba);
    if (!cel) return REF;
    const a = colLetra(c) + r;
    const k = aba + "!" + a;
    if (this.memo.has(k)) return this.memo.get(k);
    const x = cel.get(a);
    let v = null;
    if (x) {
      if (x.f == null) v = x.v ?? null;
      else {
        this.memo.set(k, 0); // proteção contra ciclo
        try { v = this.valor(this.eval(this.arvore(x.f), aba, 0)); } catch (e) { v = NOME; }
      }
    }
    this.memo.set(k, v);
    return v;
  }
  // intervalo → lista linear de valores (e o tamanho, para casar intervalos no SUMIFS)
  intervalo(no, aba, dRow) {
    const ab = no.aba ?? aba;
    const r1 = no.a.r == null ? 1 : no.a.r + (no.a.ar ? 0 : dRow), r2 = no.b.r == null ? null : no.b.r + (no.b.ar ? 0 : dRow);
    const c1 = no.a.c, c2 = no.b.c;
    const chave = `${ab}!${c1}:${r1}:${c2}:${r2}`;
    const salvo = this.rangos.get(chave);
    if (salvo) return salvo;
    const rng = this.lerIntervalo(ab, r1, r2, c1, c2, chave);
    // intervalos das abas de resumo podem mudar enquanto a aba é calculada; só os das bases ficam guardados
    if (this.base.has(ab)) this.rangos.set(chave, rng);
    return rng;
  }
  lerIntervalo(ab, r1, r2, c1, c2, chave) {
    if (this.base.has(ab)) {
      const n = this.base.get(ab).n;
      const fim = r2 == null ? n : Math.min(r2, n);
      const out = [];
      for (let c = c1; c <= c2; c++) { const col = this.coluna(ab, c); for (let r = r1; r <= fim; r++) out.push(col[r - 1] ?? null); }
      return { chave, v: out };
    }
    const fim = r2 ?? this.maxLinha(ab);
    const out = [];
    for (let r = r1; r <= fim; r++) for (let c = c1; c <= c2; c++) out.push(this.celula(ab, c, r));
    return { chave, v: out };
  }
  maxLinha(aba) {
    let m = 0;
    for (const a of this.calc.get(aba)?.keys() ?? []) m = Math.max(m, +a.replace(/^[A-Z]+/, ""));
    return m;
  }
  valor(v) { return v && typeof v === "object" && !ehErro(v) && "v" in v ? (v.v.length === 1 ? v.v[0] : VALOR) : v; }

  eval(no, aba, dRow) {
    switch (no.k) {
      case "val": return no.v;
      case "ref": return this.celula(no.aba ?? aba, no.c, no.r + (no.ar ? 0 : dRow));
      case "rng": return this.intervalo(no, aba, dRow);
      case "neg": { const x = paraNum(this.valor(this.eval(no.a, aba, dRow))); return ehErro(x) ? x : -x; }
      case "bin": return this.binario(no, aba, dRow);
      case "fn": return this.funcao(no, aba, dRow);
      default: return VALOR;
    }
  }
  binario(no, aba, dRow) {
    const a = this.valor(this.eval(no.a, aba, dRow)), b = this.valor(this.eval(no.b, aba, dRow));
    if (ehErro(a)) return a;
    if (ehErro(b)) return b;
    if (no.o === "&") return paraTexto(a) + paraTexto(b);
    if (["=", "<>", "<", ">", "<=", ">="].includes(no.o)) {
      const c = comparar(a, b);
      return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[no.o];
    }
    const x = paraNum(a), y = paraNum(b);
    if (ehErro(x)) return x;
    if (ehErro(y)) return y;
    switch (no.o) {
      case "+": return x + y;
      case "-": return x - y;
      case "*": return x * y;
      case "/": return y === 0 ? DIV0 : x / y;
      case "^": return x ** y;
      default: return VALOR;
    }
  }
  // máscara de linhas que atendem um critério (reaproveitada entre fórmulas)
  mascara(rng, crit) {
    const k = rng.chave + "|" + (typeof crit) + ":" + String(crit);
    let m = this.mascaras.get(k);
    if (!m) {
      const teste = criterio(crit);
      m = new Uint8Array(rng.v.length);
      for (let i = 0; i < rng.v.length; i++) m[i] = ehErro(rng.v[i]) ? 0 : teste(rng.v[i]) ? 1 : 0;
      this.mascaras.set(k, m);
    }
    return m;
  }
  ifs(args, aba, dRow, soma) {
    const alvo = soma ? this.eval(args[0], aba, dRow) : null;
    const pares = [];
    for (let i = soma ? 1 : 0; i < args.length; i += 2) {
      const rng = this.eval(args[i], aba, dRow);
      if (!rng?.v) return VALOR;
      const crit = this.valor(this.eval(args[i + 1], aba, dRow));
      if (ehErro(crit)) return crit;
      pares.push(this.mascara(rng, crit));
    }
    const tam = soma ? alvo.v.length : pares[0].length;
    let total = 0;
    for (let i = 0; i < tam; i++) {
      let ok = true;
      for (const m of pares) if (!m[i]) { ok = false; break; }
      if (!ok) continue;
      if (!soma) { total++; continue; }
      const v = alvo.v[i];
      if (ehErro(v)) return v;
      if (typeof v === "number") total += v;
    }
    return total;
  }
  funcao(no, aba, dRow) {
    const a = no.args;
    const ev = (i) => this.valor(this.eval(a[i], aba, dRow));
    const numeros = (fn) => {
      const out = [];
      for (const arg of a) {
        const x = this.eval(arg, aba, dRow);
        if (x?.v && Array.isArray(x.v)) { for (const v of x.v) { if (ehErro(v)) return v; if (typeof v === "number") out.push(v); } }
        else { const y = paraNum(this.valor(x)); if (ehErro(y)) return y; out.push(y); }
      }
      return fn(out);
    };
    switch (no.n) {
      case "SUMIFS": return this.ifs(a, aba, dRow, true);
      case "COUNTIFS": return this.ifs(a, aba, dRow, false);
      case "SUM": return numeros((v) => v.reduce((s, x) => s + x, 0));
      case "AVERAGE": return numeros((v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : DIV0));
      case "ROUND": { const x = paraNum(ev(0)), d = paraNum(ev(1)); return ehErro(x) ? x : ehErro(d) ? d : arredExcel(x, d); }
      case "IFERROR": { const x = ev(0); return ehErro(x) ? ev(1) : x; }
      case "IF": { const c = ev(0); if (ehErro(c)) return c; const ok = typeof c === "string" ? VALOR : !!paraNum(c); return ehErro(ok) ? ok : ok ? ev(1) : a.length > 2 ? ev(2) : false; }
      case "IFS": {
        for (let i = 0; i < a.length; i += 2) { const c = ev(i); if (ehErro(c)) return c; if (c === true || (typeof c === "number" && c !== 0)) return ev(i + 1); }
        return NA;
      }
      case "EOMONTH": { const s = paraNum(ev(0)), m = paraNum(ev(1)); return ehErro(s) ? s : ehErro(m) ? m : eomonth(s, Math.trunc(m)); }
      case "XLOOKUP": {
        const x = ev(0), em = this.eval(a[1], aba, dRow), de = this.eval(a[2], aba, dRow);
        if (ehErro(x)) return x;
        const i = em.v.findIndex((v) => (typeof x === "number" ? v === x : typeof v === "string" && textoIgual(v, x)));
        return i < 0 ? (a.length > 3 ? ev(3) : NA) : de.v[i] ?? null;
      }
      default: return NOME;
    }
  }
  // aba de resumo inteira como grade de valores (erros viram vazio)
  grade(aba) {
    const cel = this.calc.get(aba);
    let mr = 0, mc = 0;
    for (const a of cel.keys()) { const [, L, r] = /^([A-Z]+)(\d+)$/.exec(a); mr = Math.max(mr, +r); mc = Math.max(mc, colNum(L)); }
    const g = [];
    for (let r = 1; r <= mr; r++) {
      const l = new Array(mc).fill(null);
      for (let c = 1; c <= mc; c++) { const v = this.celula(aba, c, r); l[c - 1] = ehErro(v) ? null : v; }
      g.push(l);
    }
    return g;
  }
  // aba base como grade (cabeçalho + linhas), com as colunas cinzas calculadas
  gradeBase(aba) {
    const b = this.base.get(aba);
    const cs = Object.keys(b.titulos).map(colNum);
    const mc = Math.max(...cs);
    const cols = new Map(cs.map((c) => [c, this.coluna(aba, c)]));
    const g = [];
    for (let r = 0; r < b.n; r++) {
      const l = new Array(mc).fill(null);
      for (const [c, col] of cols) { const v = col[r]; l[c - 1] = ehErro(v) ? null : v; }
      g.push(l);
    }
    return g;
  }
}

// =====================================================================
// MODELO (extraído da planilha no upload) E CÁLCULO PELA API
// =====================================================================
// Guarda as fórmulas das abas de resumo, os títulos e as fórmulas (linha 2) das abas base,
// a tabela List e as operações de futuros da aba OpenFutures.
export function extrairModelo(XLSX, wb) {
  const faltam = [...ABAS_CALCULO, ...ABAS_BASE, "List"].filter((n) => !wb.Sheets[n]);
  if (faltam.length) throw new Error(`Sheet(s) not found: ${faltam.join(", ")}.`);
  const abas = {};
  for (const nome of ABAS_CALCULO) {
    const ws = wb.Sheets[nome], cel = {};
    for (const [a, c] of Object.entries(ws)) {
      if (a[0] === "!") continue;
      if (c.f) cel[a] = { f: c.f };
      else if (c.t !== "e" && c.v != null && c.v !== "") cel[a] = { v: c.v };
    }
    abas[nome] = cel;
  }
  const bases = Object.fromEntries(ABAS_BASE.map((nome) => [nome, estruturaBase(XLSX, wb.Sheets[nome])]));
  const lista = {};
  const wl = wb.Sheets.List;
  const rl = XLSX.utils.decode_range(wl["!ref"]);
  for (let C = 0; C <= rl.e.c; C++) {
    const L = XLSX.utils.encode_col(C), vals = [];
    for (let R = 0; R <= rl.e.r; R++) { const c = wl[`${L}${R + 1}`]; vals.push(c && c.t !== "e" ? c.v ?? null : null); }
    while (vals.length && vals[vals.length - 1] == null) vals.pop();
    if (vals.length) lista[L] = vals;
  }
  return { versao: 1, abas, bases, lista, futuros: extrairFuturos(XLSX, wb) };
}

// Títulos (linha 1) e fórmulas das colunas cinzas (linha 2) de uma aba base
function estruturaBase(XLSX, ws) {
  const r = XLSX.utils.decode_range(ws["!ref"]);
  const cabecalho = {}, formulas = {};
  for (let C = 0; C <= r.e.c; C++) {
    const L = XLSX.utils.encode_col(C);
    const h = ws[`${L}1`];
    if (h?.v == null || String(h.v).trim() === "") continue;
    cabecalho[L] = String(h.v);
    const f2 = ws[`${L}2`]?.f;
    if (f2) formulas[L] = f2;
  }
  return { cabecalho, formulas };
}

// Operações de futuros da aba OpenFutures: só as colunas digitadas (as cinzas o avaliador recalcula)
export function extrairFuturos(XLSX, wb) {
  const ws = wb.Sheets.OpenFutures;
  if (!ws?.["!ref"]) throw new Error('Sheet "OpenFutures" not found.');
  const { cabecalho, formulas } = estruturaBase(XLSX, ws);
  const r = XLSX.utils.decode_range(ws["!ref"]);
  const futuros = [];
  for (let R = 1; R <= r.e.r; R++) {
    const o = {};
    for (const [L, titulo] of Object.entries(cabecalho)) {
      if (formulas[L]) continue;
      const c = ws[`${L}${R + 1}`];
      if (c && c.t !== "e" && c.v != null && c.v !== "") o[titulo.trim()] = c.v;
    }
    if (Object.keys(o).length) futuros.push(o);
  }
  if (!futuros.length) throw new Error('Sheet "OpenFutures" has no trades.');
  return futuros;
}

// Linhas das abas base montadas a partir das consultas do Digisul
export function basesDaApi(api) {
  const out = {};
  for (const [nome, q] of Object.entries(CONSULTAS)) out[q.aba] = (api[nome] ?? []).map(q.linha);
  return out;
}

// Células "Previous" da Variation: posição do último dia anterior (no lugar do valor digitado)
function sobreporAnterior(modelo, anterior) {
  if (!anterior) return {};
  const cel = modelo.abas[ABAS.variacao], out = {};
  const pos = new Map(Object.entries(cel).map(([a, x]) => [a, x.v]));
  for (const [a, x] of Object.entries(cel)) {
    const chave = NOMES_VARIACAO[norm(x.v)];
    if (!chave || !anterior[chave]) continue;
    const [, L, r] = /^([A-Z]+)(\d+)$/.exec(a);
    const c = colNum(L);
    if (!norm(pos.get(colLetra(c + 1) + r)).startsWith("NET DIFF")) continue;
    for (let k = +r + 1; k <= +r + 3; k++) {
      if (norm(pos.get(L + k)) !== "PREVIOUS") continue;
      out[colLetra(c + 1) + k] = anterior[chave].diff;
      out[colLetra(c + 2) + k] = anterior[chave].outright;
      break;
    }
  }
  return { [ABAS.variacao]: out };
}

// Calcula a Position inteira: bases = { aba: linhas }, hoje = "AAAA-MM-DD",
// anterior = kpis do último dia anterior { arabica: {diff, outright}, ... } (opcional)
export function calcularPosition(modelo, bases, { hoje = hojeSP(), anterior = null } = {}) {
  const todas = { ...bases, OpenFutures: bases.OpenFutures ?? modelo.futuros };
  const sobrepor = sobreporAnterior(modelo, anterior);
  // "UPDATED AS OF" = hoje; as demais abas apontam para essa célula
  (sobrepor[ABAS.termm] ??= {}).A1 = isoSerial(hoje);
  const pasta = new Pasta(modelo, todas, sobrepor);
  const grades = new Map();
  const gAba = (nome) => {
    if (!grades.has(nome)) grades.set(nome, ABAS_CALCULO.includes(nome) ? pasta.grade(nome) : pasta.gradeBase(nome));
    return grades.get(nome);
  };
  return { ...montarPosition(gAba), pasta };
}
