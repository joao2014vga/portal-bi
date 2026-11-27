// Dashboard Brokers: página nativa do portal (card portal:corretores).
//
// Tudo de cada corretor, compra e venda:
//   - contratos, sacas, o que já foi entregue e o que falta entregar, a % e a corretagem
//     estimada: ao vivo do Digisul pelo brascof-api (/api/corretores), com as mesmas regras do
//     Espelho de Corretagem (base × % cadastrada; produtor pessoa física × 1,01; cancelado com
//     comissão entra com a comissão do Digisul);
//   - o valor PAGO de corretagem: os espelhos marcados como "Paid" no Espelho de Corretagem
//     (Supabase, bi_corretagem_conf). Quem não tem acesso ao card do Espelho não vê os espelhos.
// Corretagem "sobre o entregue" = corretagem do contrato × sacas entregues / (entregues + a entregar).
// A página abre com um card por corretor; clicar num card abre o corretor (contratos, espelhos,
// fornecedores/clientes).
import { esc, $, $$, icon, toast, tempoRelativo, cabecalho as cabecalhoPagina } from "./ui.js";
import { fmtN, fmtData, fmtMes, segmentos, ligarSegmentos } from "./position.js";

export const ehPainelCorretores = (link) => link === "portal:corretores";

const TIPOS = { PURCHASE: "Purchase", SALE: "Sale" };
const STATUS_ESP = { pending: "Statement pending", received: "Received", divergent: "Divergent", checked: "Checked", paid: "Paid" };
const CLS_ESP = { pending: "pill", received: "pill pill-adm", divergent: "pill pill-alerta", checked: "pill pill-ok", paid: "pill pill-ok" };
// colunas da tabela de corretores: [chave, título, valor para ordenar, direção inicial (1 = crescente), dica]
const COLS = [
  ["nome", "Broker", (c) => c.nome, 1],
  ["ctrC", "Purchases", (c) => c.m.ctrC.size, -1, "Purchase contracts"],
  ["ctrV", "Sales", (c) => c.m.ctrV.size, -1, "Sale contracts"],
  ["sacas", "Bags", (c) => c.m.sacas, -1],
  ["entregue", "Delivered", (c) => c.m.entregue, -1, "Bags delivered; the bar is the share of the contracts already delivered"],
  ["aEntregar", "To deliver", (c) => c.m.aEntregar, -1],
  ["corretagem", "Brokerage (est.) R$", (c) => c.m.corretagem, -1, "Contract value × rate in Digisul"],
  ["pago", "Paid R$", (c) => c.e.pago, -1, "Statements marked Paid in the Brokerage Statement"],
  ["pct", "Avg rate", (c) => c.m.pct ?? -1, -1],
  ["proximo", "Next due", (c) => c.m.proximo?.vencimento ?? "9999", 1, "Earliest due date among the contracts still to deliver"],
  ["ultimo", "Last contract", (c) => c.m.ultimo?.emissao ?? "", -1, "Issue date of the latest contract"],
];
const estado = { tipo: "todos", especie: "todas", ano: "", busca: "", ordem: "aEntregar", dir: -1, sel: null, aba: "aberto",
  // filtros de data (aaaa-mm-dd): vencimento e data Futuro do Digisul; soAbertos = só com saldo a entregar
  // soAtrasados = só os atrasados de verdade (atalho "Overdue"; ver `vencido`)
  venDe: "", venAte: "", futDe: "", futAte: "", soAbertos: false, soAtrasados: false };

// datas no fuso do navegador (aaaa-mm-dd)
const diaIso = (d) => d.toLocaleDateString("sv-SE");
const hojeIso = () => diaIso(new Date());
const daquiDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return diaIso(d); };
// atalhos do vencimento: sempre só contratos com saldo a entregar
const ATALHOS = [["vencidos", "Overdue"], ["30", "Next 30 days"], ["60", "Next 60 days"], ["90", "Next 90 days"]];
// "Overdue" não limita o vencimento: pega também os remarcados (data Futuro passada, vencimento à frente)
const atalho = (k) => (k === "vencidos" ? { venDe: "", venAte: "", soAtrasados: true }
  : { venDe: hojeIso(), venAte: daquiDias(Number(k)), soAtrasados: false });
const atalhoAtivo = () => (estado.soAbertos && !estado.futDe && !estado.futAte
  ? ATALHOS.find(([k]) => { const a = atalho(k); return a.venDe === estado.venDe && a.venAte === estado.venAte && a.soAtrasados === estado.soAtrasados; })?.[0] ?? "" : "");
const datasAtivas = () => !!(estado.venDe || estado.venAte || estado.futDe || estado.futAte || estado.soAbertos || estado.soAtrasados);
const entre = (d, de, ate) => (!de && !ate) || (!!d && (!de || d >= de) && (!ate || d <= ate));
// Atrasado: a data mais cedo entre a data Futuro e o vencimento já passou e ainda falta entregar
// MAIS de 20% das sacas do contrato. Um saldo pequeno (ex.: 1 saca de 2.000) é quebra, não atraso.
// Data Futuro passada com vencimento ainda à frente = atrasado e REMARCADO: o vencimento é a data
// nova em que o café vem, e fica em destaque para não ser esquecido.
const LIMITE_ATRASO = 0.2;
const dataAtraso = (r) => [r.futuro, r.vencimento].filter(Boolean).sort()[0] ?? null;
const vencido = (r) => r._st === "aberto" && !!dataAtraso(r) && dataAtraso(r) < hojeIso()
  && (Number(r.aEntregar) || 0) > LIMITE_ATRASO * (Number(r.sacas) || 0);
const remarcado = (r) => vencido(r) && !!r.futuro && r.futuro < hojeIso() && !!r.vencimento && r.vencimento >= hojeIso();

const reais = (v) => (v == null ? "—" : `R$ ${fmtN(v, 2)}`);
const reais0 = (v) => (v == null ? "—" : `R$ ${fmtN(v)}`);
const pctFmt = (v) => (v == null ? "—" : `${fmtN(v, 2)}%`);
const soma = (xs, f) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const cafeCurto = (e) => (e === "ARABICA" ? "Arabica" : e === "CONILON" ? "Conilon" : e ?? "—");
// aviso dos contratos a fixar ainda sem preço (fora da corretagem estimada)
const avisoSemPreco = (m, sep = " · ") => (m.semPreco.size
  ? `${sep}<span class="cor-falta" title="Contracts to be fixed with a provisional price in Digisul: their brokerage is not counted until the price is fixed">${fmtN(m.semPreco.size)} <span>to fix, not counted</span> (${fmtN(m.sacasSemPreco)} <span>bags</span>)</span>` : "");

// Contrato a fixar que ainda não tem preço vem do Digisul com preço provisório (R$ 0,01 a 0,60 por
// saca): a corretagem dele ainda não existe. Mesma regra do Dashboard Purchases (PRECO_MIN_SACA):
// fica "to fix", fora dos totais e da % média. Nenhum preço real de café chega perto de R$ 100/saca.
const PRECO_MIN_SACA = 100;

// fração entregue do contrato e a corretagem que cabe ao que já foi entregue
// (_corr = corretagem que conta nos totais: 0 no contrato ainda sem preço)
function preparar(r) {
  const ent = Math.max(0, Number(r.entregue) || 0), falta = Math.max(0, Number(r.aEntregar) || 0);
  const frac = r.cancelado || falta <= 0 ? 1 : ent + falta > 0 ? ent / (ent + falta) : 0;
  r._semPreco = !r.cancelado && r.sacas > 0 && (Number(r.base) || 0) / r.sacas < PRECO_MIN_SACA;
  r._corr = r._semPreco ? 0 : Number(r.corretagem) || 0;
  r._frac = frac;
  r._corrEnt = r._corr * frac;
  r._corrFalta = r._corr - r._corrEnt;
  r._st = r.cancelado ? "cancelado" : falta > 0 ? "aberto" : "entregue";
  return r;
}

function agregar(linhas) {
  const m = { ctr: new Set(), ctrC: new Set(), ctrV: new Set(), sacas: 0, entregue: 0, aEntregar: 0, corretagem: 0, corrEnt: 0, corrFalta: 0,
    pctPeso: 0, base: 0, ultimo: null, proximo: null, abertos: new Set(), semPreco: new Set(), sacasSemPreco: 0, atrasados: new Set() };
  for (const r of linhas) {
    const k = `${r.tipo}|${r.contrato}`;
    m.ctr.add(k); (r.tipo === "PURCHASE" ? m.ctrC : m.ctrV).add(k);
    m.sacas += r.sacas || 0; m.entregue += r.cancelado ? 0 : r.entregue || 0; m.aEntregar += r.aEntregar || 0;
    m.corretagem += r._corr; m.corrEnt += r._corrEnt; m.corrFalta += r._corrFalta;
    if (r._semPreco) { m.semPreco.add(k); m.sacasSemPreco += r.sacas || 0; }
    else if (!r.cancelado && r.base > 0) { m.pctPeso += r.base * r.pct; m.base += r.base; }
    if (r.emissao && (!m.ultimo || r.emissao > m.ultimo.emissao)) m.ultimo = r;
    if (vencido(r)) m.atrasados.add(k);
    if (r._st === "aberto") {
      m.abertos.add(k);
      if (r.vencimento && (!m.proximo || r.vencimento < m.proximo.vencimento)) m.proximo = r;
    }
  }
  m.pct = m.base ? m.pctPeso / m.base : null;
  return m;
}

// espelhos do Espelho de Corretagem: pago = status 'paid'; a pagar = recebido/conferido/divergente
function somaEspelhos(espelhos) {
  const pagos = espelhos.filter((e) => e.status === "paid");
  const aPagar = espelhos.filter((e) => ["received", "checked", "divergent"].includes(e.status));
  return {
    pago: soma(pagos, (e) => e.espelho_valor), nPago: pagos.length, semValor: pagos.filter((e) => e.espelho_valor == null).length,
    aPagar: soma(aPagar, (e) => e.espelho_valor), nAPagar: aPagar.length,
    desde: espelhos.reduce((d, e) => (!d || e.mes < d ? e.mes : d), null),
  };
}

export async function renderCorretores(link, alvo, ctx) {
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading brokers from Digisul…</div>`;
  let digisul, espelhos = [], espelhosErro = null;
  const carregar = async (fresco = false) => {
    const [d, e] = await Promise.allSettled([ctx.api.corretoresDigisul(fresco), ctx.api.corretagemEspelhos()]);
    if (d.status === "rejected") throw d.reason;
    digisul = d.value;
    for (const r of digisul.linhas) preparar(r);
    if (e.status === "fulfilled") { espelhos = e.value ?? []; espelhosErro = null; } else { espelhos = []; espelhosErro = e.reason.message; }
  };
  try {
    await carregar();
  } catch (e) {
    alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Brokers are not available</h3><p>${esc(e.message)}</p>
      <button class="btn" id="corTentar">${icon("refresh")}<span>Try again</span></button></div>`;
    $("#corTentar", alvo)?.addEventListener("click", () => renderCorretores(link, alvo, ctx));
    return;
  }

  const anos = () => [...new Set(digisul.linhas.map((r) => r.emissao?.slice(0, 4)).filter(Boolean))].sort().reverse();
  const filtradas = () => {
    const t = estado.busca.trim().toLowerCase();
    return digisul.linhas.filter((r) => (estado.tipo === "todos" || r.tipo === estado.tipo)
      && (estado.especie === "todas" || r.especie === estado.especie)
      && (!estado.ano || r.emissao?.startsWith(estado.ano))
      && entre(r.vencimento, estado.venDe, estado.venAte) && entre(r.futuro, estado.futDe, estado.futAte)
      && (!estado.soAbertos || r._st === "aberto") && (!estado.soAtrasados || vencido(r))
      && (!t || [r.nome, r.contrato, r.contraparte].some((v) => String(v ?? "").toLowerCase().includes(t))));
  };
  // espelhos valem para o corretor inteiro (compra e venda juntos): só o café filtra
  const espelhosDe = (cod) => espelhos.filter((e) => (cod == null || String(e.corretor_cod) === String(cod))
    && (estado.especie === "todas" || e.especie === estado.especie));

  const desenhar = () => {
    const linhas = filtradas();
    const porCorr = new Map();
    for (const r of linhas) {
      const o = porCorr.get(r.cod) ?? porCorr.set(r.cod, { cod: r.cod, nome: r.nome, linhas: [] }).get(r.cod);
      o.linhas.push(r);
    }
    const corrs = [...porCorr.values()].map((o) => ({ ...o, m: agregar(o.linhas), e: somaEspelhos(espelhosDe(o.cod)) }));
    const sel = estado.sel != null ? corrs.find((c) => String(c.cod) === String(estado.sel)) : null;
    if (estado.sel != null && !sel) estado.sel = null;

    const filtros = `<div class="pos-filtros">
      ${segmentos("corTipo", [["todos", "Purchases and sales"], ["PURCHASE", "Purchases"], ["SALE", "Sales"]], estado.tipo)}
      ${segmentos("corEsp", [["todas", "All coffees"], ["ARABICA", "Arabica"], ["CONILON", "Conilon"]], estado.especie)}
      <label class="pos-mes"><span>Issued in</span><select id="corAno" aria-label="Issue year">
        <option value="">All years</option>${anos().map((a) => `<option value="${a}" ${a === estado.ano ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      <label class="busca sm">${icon("search")}<input type="search" id="corBusca" placeholder="Search broker, contract, supplier or client…" value="${esc(estado.busca)}"></label>
    </div>
    <div class="pos-filtros cor-datas">
      <span class="cor-dt" title="Purchase: due date in Digisul. Sale: 1st due date (Normal) or estimated shipment (other modalities)">
        <span class="cor-dt-rot">Due date</span>
        <input type="date" data-data="venDe" value="${esc(estado.venDe)}" aria-label="Due date from"><span>to</span>
        <input type="date" data-data="venAte" value="${esc(estado.venAte)}" aria-label="Due date to"></span>
      <span class="cor-dt" title="The Futuro date of the contract in Digisul">
        <span class="cor-dt-rot">Futuro date</span>
        <input type="date" data-data="futDe" value="${esc(estado.futDe)}" aria-label="Futuro date from"><span>to</span>
        <input type="date" data-data="futAte" value="${esc(estado.futAte)}" aria-label="Futuro date to"></span>
      <label class="check-linha"><input type="checkbox" id="corSoAbertos" ${estado.soAbertos ? "checked" : ""}><span>Only with bags to deliver</span></label>
      ${segmentos("corAtalho", ATALHOS, atalhoAtivo())}
      ${datasAtivas() ? `<button type="button" class="btn" id="corLimparDatas">${icon("x")}<span>Clear dates</span></button>` : ""}
    </div>`;

    alvo.innerHTML = `<div class="pos">
      ${cabecalhoPagina({
        titulo: ctx.titulo || "Dashboard Brokers",
        sub: `<span>Digisul data</span> <strong>${esc(tempoRelativo(digisul.consultadoEm))}</strong> · <span>contracts issued from 2020</span>`,
        acoes: `<button class="btn" id="corSync" title="Fetch Digisul now">${icon("refresh")}<span>Update now</span></button>`,
      })}
      ${filtros}
      ${espelhosErro ? `<p class="muted pos-nota">${icon("alert")} <span>Brokerage statements could not be loaded:</span> <span>${esc(espelhosErro)}</span></p>` : ""}
      ${sel ? detalhe(sel) : visaoGeral(corrs, linhas)}
    </div>`;

    ligarSegmentos(alvo, "corTipo", (k) => { estado.tipo = k; desenhar(); });
    ligarSegmentos(alvo, "corEsp", (k) => { estado.especie = k; desenhar(); });
    // cabeçalho da tabela: mesma coluna inverte a ordem; outra coluna começa na direção dela
    $$("[data-ordem]", alvo).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.ordem;
      estado.dir = estado.ordem === k ? -estado.dir : COLS.find(([c]) => c === k)[3];
      estado.ordem = k;
      desenhar();
    }));
    ligarSegmentos(alvo, "corAba", (k) => { estado.aba = k; desenhar(); });
    $("#corAno", alvo).addEventListener("change", (e) => { estado.ano = e.target.value; desenhar(); });
    // mexer numa data ou no "só com saldo" à mão tira o "só atrasados" do atalho Overdue
    $$("[data-data]", alvo).forEach((i) => i.addEventListener("change", () => { estado[i.dataset.data] = i.value; estado.soAtrasados = false; desenhar(); }));
    $("#corSoAbertos", alvo).addEventListener("change", (e) => { estado.soAbertos = e.target.checked; estado.soAtrasados = false; desenhar(); });
    ligarSegmentos(alvo, "corAtalho", (k) => {
      Object.assign(estado, atalho(k), { futDe: "", futAte: "", soAbertos: true });
      if (estado.sel == null) { estado.ordem = "aEntregar"; estado.dir = -1; } else estado.aba = "aberto";
      desenhar();
    });
    $("#corLimparDatas", alvo)?.addEventListener("click", () => { Object.assign(estado, { venDe: "", venAte: "", futDe: "", futAte: "", soAbertos: false, soAtrasados: false }); desenhar(); });
    const fb = $("#corBusca", alvo);
    fb.addEventListener("input", () => { estado.busca = fb.value; desenhar(); const n = $("#corBusca", alvo); n.focus(); n.setSelectionRange(estado.busca.length, estado.busca.length); });
    $$("[data-corr]", alvo).forEach((b) => b.addEventListener("click", () => { estado.sel = b.dataset.corr; estado.aba = "aberto"; desenhar(); alvo.scrollIntoView?.({ block: "start" }); }));
    $("#corVoltar", alvo)?.addEventListener("click", () => { estado.sel = null; desenhar(); });
    $("#corSync", alvo).addEventListener("click", async (e) => {
      const b = e.currentTarget; b.disabled = true; b.classList.add("loading");
      try { await carregar(true); desenhar(); toast("Brokers updated from Digisul."); }
      catch (err) { toast(err.message, "erro"); b.disabled = false; b.classList.remove("loading"); }
    });
  };

  const kpi = (titulo, valor, sub = "", cls = "") => `<div class="pos-kpi pos-kpi-est ${cls}"><span class="pos-kpi-t">${esc(titulo)}</span>
    <span class="pos-kpi-v">${valor}</span>${sub ? `<span class="pos-kpi-s">${sub}</span>` : ""}</div>`;
  const progresso = (m) => {
    const tot = m.entregue + m.aEntregar, p = tot ? (m.entregue / tot) * 100 : 0;
    return `<div class="cor-prog" role="img" aria-label="${fmtN(p)}% delivered"><i style="width:${p.toFixed(1)}%"></i></div>`;
  };
  const kpisPago = (e) => kpi("Brokerage paid", reais(e.pago),
    e.nPago ? `<span>${fmtN(e.nPago)} paid statements</span>${e.desde ? ` · <span>since</span> ${esc(fmtMes(`${e.desde}-01`))}` : ""}${e.semValor ? ` · <span>${fmtN(e.semValor)} without amount</span>` : ""}`
      : espelhosErro ? "statements unavailable" : "no paid statement yet")
    + kpi("Awaiting payment", reais(e.aPagar), `<span>${fmtN(e.nAPagar)} statements received, not paid</span>`);

  // ------------------------------------------------------------ todos os corretores
  const visaoGeral = (corrs, linhas) => {
    const m = agregar(linhas), e = somaEspelhos(espelhosDe(null).filter((x) => corrs.some((c) => String(c.cod) === String(x.corretor_cod))));
    // vencidos com saldo a entregar (contrato contado uma vez, mesmo com dois corretores)
    const atrasados = new Map(linhas.filter(vencido).map((r) => [`${r.tipo}|${r.contrato}`, r.aEntregar || 0]));
    const sacasAtrasadas = [...atrasados.values()].reduce((s, v) => s + v, 0);
    const col = COLS.find(([k]) => k === estado.ordem) ?? COLS[5];
    const val = col[2];
    const lista = corrs.sort((a, b) => {
      const x = val(a), y = val(b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * estado.dir || a.nome.localeCompare(b.nome);
    });
    return `
      <div class="pos-kpis">
        ${kpi("Brokers", fmtN(corrs.length), `<span>${fmtN(m.ctr.size)} contracts</span> · <span>Purchases</span> ${fmtN(m.ctrC.size)} · <span>Sales</span> ${fmtN(m.ctrV.size)}`)}
        ${kpi("Bags delivered", fmtN(m.entregue), `<span>of</span> ${fmtN(m.sacas)} <span>bags</span>${progresso(m)}`)}
        ${kpi("Bags to deliver", fmtN(m.aEntregar), `<span>${fmtN(m.abertos.size)} open contracts</span>${atrasados.size ? ` · <span class="cor-falta">${fmtN(atrasados.size)} <span>overdue</span> (${fmtN(sacasAtrasadas)} <span>bags</span>)</span>` : ""}`, m.aEntregar ? "cor-kpi-falta" : "")}
        ${kpi("Brokerage (est.)", reais(m.corretagem), `<span>on delivered</span> ${reais(m.corrEnt)} · <span>to deliver</span> ${reais(m.corrFalta)}${avisoSemPreco(m)}`)}
        ${kpisPago(e)}
      </div>
      ${datasAtivas() ? `<section class="pos-card">
        <div class="pos-card-h"><h2>Contracts in these dates</h2><p class="muted"><span>${fmtN(new Set(linhas.map((r) => `${r.tipo}|${r.contrato}`)).size)} contracts</span> · <span>By due date. A contract with two brokers appears once for each.</span></p></div>
        ${tabelaContratos([...linhas].sort((a, b) => (a.vencimento ?? "9999").localeCompare(b.vencimento ?? "9999") || a.contrato.localeCompare(b.contrato)), true)}
      </section>` : ""}
      <p class="muted pos-nota">${icon("info")} <span>Brokerage (est.) = contract value × rate registered in Digisul, as in the Brokerage Statement. A contract with two brokers counts for both. Contracts to be fixed that still have a provisional price (under R$ 100/bag) are not counted, as in the Dashboard Purchases. Paid = statements marked “Paid” in the Brokerage Statement (purchases and sales together).</span></p>
      <section class="pos-card">
        <div class="pos-card-h"><h2>Brokers</h2><p class="muted"><span>${fmtN(lista.length)} ${lista.length === 1 ? "broker" : "brokers"}</span> · <span>Click a column to sort and a broker to open it.</span></p></div>
        ${lista.length ? `<div class="tabela-wrap pos-tabela cor-tabela"><table class="tabela tabela-num">
          <thead><tr>${COLS.map(([k, rot, , , dica]) => `<th class="${k === "nome" ? "" : "num"}" ${dica ? `title="${esc(dica)}"` : ""} aria-sort="${estado.ordem === k ? (estado.dir > 0 ? "ascending" : "descending") : "none"}">
            <button type="button" class="ordenar" data-ordem="${k}">${esc(rot)}${estado.ordem === k ? (estado.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`).join("")}</tr></thead>
          <tbody>${lista.map(linhaCorretor).join("")}</tbody>
          ${lista.length > 1 ? `<tfoot><tr class="total"><td>Total</td><td class="num">${fmtN(m.ctrC.size)}</td><td class="num">${fmtN(m.ctrV.size)}</td>
            <td class="num">${fmtN(m.sacas)}</td><td class="num">${celEntregue(m)}</td><td class="num">${fmtN(m.aEntregar)}</td>
            <td class="num">${reais0(m.corretagem)}</td><td class="num">${e.nPago ? reais0(e.pago) : "—"}</td><td class="num">${pctFmt(m.pct)}</td><td></td><td></td></tr></tfoot>` : ""}
        </table></div>` : `<p class="vazio-td">No brokers for these filters.</p>`}
      </section>`;
  };

  const celEntregue = (m) => {
    const tot = m.entregue + m.aEntregar, p = tot ? (m.entregue / tot) * 100 : 0;
    return `<span class="cor-ent" title="${fmtN(p)}% delivered"><span class="cor-prog"><i style="width:${p.toFixed(1)}%"></i></span><span>${fmtN(m.entregue)}</span></span>`;
  };
  const linhaCorretor = (c) => {
    const m = c.m;
    return `<tr class="pos-clic" data-corr="${esc(c.cod)}">
      <td><button type="button" class="link cor-nome">${esc(c.nome)}</button>${m.semPreco.size ? `<div class="cor-sub">${avisoSemPreco(m, "")}</div>` : ""}</td>
      <td class="num">${m.ctrC.size ? fmtN(m.ctrC.size) : `<span class="zero">–</span>`}</td><td class="num">${m.ctrV.size ? fmtN(m.ctrV.size) : `<span class="zero">–</span>`}</td>
      <td class="num">${fmtN(m.sacas)}</td><td class="num">${celEntregue(m)}</td>
      <td class="num ${m.aEntregar ? "cor-falta forte" : ""}">${m.aEntregar ? fmtN(m.aEntregar) : `<span class="zero">–</span>`}</td>
      <td class="num forte">${reais0(m.corretagem)}</td><td class="num">${c.e.nPago ? reais0(c.e.pago) : `<span class="zero">–</span>`}</td>
      <td class="num">${pctFmt(m.pct)}</td><td class="num ${m.atrasados.size ? "cor-falta forte" : ""}" ${m.atrasados.size ? `title="${fmtN(m.atrasados.size)} overdue: due date passed with more than 20% of the contract still to deliver"` : ""}>${m.proximo ? esc(fmtData(m.proximo.vencimento)) : `<span class="zero">–</span>`}</td>
      <td class="num">${m.ultimo ? esc(fmtData(m.ultimo.emissao)) : "—"}</td></tr>`;
  };

  // contratos (do corretor aberto, ou de todos os corretores quando há filtro de data)
  const tabelaContratos = (rows, comCorretor) => {
    const nCols = comCorretor ? 15 : 14;
    return `<div class="tabela-wrap pos-tabela"><table class="tabela tabela-num pos-contratos-cor">
      <thead><tr><th>Contract</th>${comCorretor ? "<th>Broker</th>" : ""}<th>Type</th><th>Supplier / client</th><th>Coffee</th><th>Quality</th><th>Issued</th>
        <th title="Purchase: due date in Digisul. Sale: 1st due date (Normal) or estimated shipment (other modalities)">Due date</th><th title="The Futuro date of the contract in Digisul">Futuro date</th>
        <th class="num">Bags</th><th class="num">Delivered</th><th class="num">To deliver</th><th class="num">Rate</th><th class="num">Brokerage R$</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr class="${vencido(r) ? "linha-alerta" : ""}">
        <td class="nowrap">${esc(r.contrato)}${r.cancelado ? ` <span class="pill pill-alerta" title="Cancelled in Digisul with commission (e.g. washout): brokerage = commission registered in Digisul">Cancelled</span>` : ""}${r.herdado ? ` <span class="pill" title="Split contract: broker taken from ${esc(r.pai)}">Split</span>` : ""}</td>
        ${comCorretor ? `<td><button type="button" class="link" data-corr="${esc(r.cod)}">${esc(r.nome)}</button></td>` : ""}
        <td>${TIPOS[r.tipo]}${r.modalidade ? `<div class="cor-sub muted">${esc(r.modalidade)}</div>` : ""}</td><td>${esc(r.contraparte ?? "—")}</td><td>${esc(cafeCurto(r.especie))}</td><td>${esc(r.padrao ?? "—")}</td>
        <td>${esc(fmtData(r.emissao))}</td>
        <td class="nowrap">${remarcado(r) ? `<strong>${esc(fmtData(r.vencimento))}</strong>` : esc(fmtData(r.vencimento))}${vencido(r) ? ` <span class="pill pill-alerta" title="${remarcado(r) ? "Futuro date passed with more than 20% of the contract still to deliver; the due date is the new date" : "Due date passed with more than 20% of the contract still to deliver"}">Overdue</span>` : ""}${remarcado(r) ? `<div class="cor-sub cor-falta" title="The Futuro date passed: the coffee is late and now expected on the due date">Rescheduled · Futuro ${esc(fmtData(r.futuro))} passed</div>` : ""}${r.saida ? `<div class="cor-sub muted"><span>shipped</span> ${esc(fmtData(r.saida))}</div>` : ""}</td>
        <td class="${remarcado(r) ? "cor-falta forte" : ""}">${esc(fmtData(r.futuro))}</td>
        <td class="num">${fmtN(r.sacas)}</td><td class="num">${r.cancelado ? "—" : fmtN(r.entregue)}</td>
        <td class="num ${r.aEntregar ? "forte" : ""}">${r.aEntregar ? fmtN(r.aEntregar) : `<span class="zero">–</span>`}</td>
        <td class="num">${pctFmt(r.pct)}</td><td class="num">${r._semPreco ? `<span class="pill pill-alerta" title="Price to be fixed: Digisul has a provisional price (R$ ${fmtN(r.base / r.sacas, 2)}/bag), so the brokerage is not counted yet">To fix</span>` : reais(r.corretagem)}${r.pf ? ` <span class="muted" title="Individual producer: base × 1.01">PF</span>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="${nCols}" class="vazio-td">No contracts here.</td></tr>`}</tbody>
      ${rows.length > 1 ? `<tfoot><tr class="total"><td>Total</td><td colspan="${nCols - 6}"></td><td class="num">${fmtN(soma(rows, (r) => r.sacas))}</td>
        <td class="num">${fmtN(soma(rows, (r) => (r.cancelado ? 0 : r.entregue)))}</td><td class="num">${fmtN(soma(rows, (r) => r.aEntregar))}</td><td></td>
        <td class="num">${reais(soma(rows, (r) => r._corr))}</td></tr></tfoot>` : ""}
    </table></div>`;
  };

  // ------------------------------------------------------------ um corretor
  const detalhe = (c) => {
    const m = c.m, esp = espelhosDe(c.cod).sort((a, b) => b.mes.localeCompare(a.mes) || String(a.especie).localeCompare(String(b.especie)));
    const porTipo = ["PURCHASE", "SALE"].map((t) => [t, c.linhas.filter((r) => r.tipo === t)]).filter(([, ls]) => ls.length);
    const grupos = { aberto: [], entregue: [], cancelado: [] };
    for (const r of c.linhas) grupos[r._st].push(r);
    const lista = estado.aba === "todos" ? c.linhas : grupos[estado.aba];
    const ordenada = [...lista].sort(estado.aba === "aberto"
      ? (a, b) => (a.vencimento ?? "9999").localeCompare(b.vencimento ?? "9999") || a.contrato.localeCompare(b.contrato)
      : (a, b) => (b.emissao ?? "").localeCompare(a.emissao ?? "") || a.contrato.localeCompare(b.contrato));
    // fornecedores / clientes do corretor
    const contra = new Map();
    for (const r of c.linhas) {
      const k = `${r.tipo}|${r.contraparte ?? "—"}`;
      const o = contra.get(k) ?? contra.set(k, { tipo: r.tipo, nome: r.contraparte ?? "—", ctr: new Set(), sacas: 0, aEntregar: 0, corretagem: 0 }).get(k);
      o.ctr.add(r.contrato); o.sacas += r.sacas || 0; o.aEntregar += r.aEntregar || 0; o.corretagem += r._corr;
    }
    const topContra = [...contra.values()].sort((a, b) => b.sacas - a.sacas).slice(0, 15);
    const linhaTipo = (rot, ls) => { const x = agregar(ls); return `<tr><td>${rot}</td><td class="num">${fmtN(x.ctr.size)}</td><td class="num">${fmtN(x.sacas)}</td>
      <td class="num">${fmtN(x.entregue)}</td><td class="num">${fmtN(x.aEntregar)}</td><td class="num">${pctFmt(x.pct)}</td><td class="num">${reais(x.corretagem)}</td>
      <td class="num">${reais(x.corrEnt)}</td><td class="num">${reais(x.corrFalta)}</td></tr>`; };

    return `
      <div class="cor-det-h">
        <button type="button" class="btn" id="corVoltar">${icon("back")}<span>All brokers</span></button>
        <h2>${esc(c.nome)}</h2>
        <span class="cor-tags">${m.ctrC.size ? `<span class="pill">${fmtN(m.ctrC.size)} <span>purchases</span></span>` : ""}${m.ctrV.size ? `<span class="pill">${fmtN(m.ctrV.size)} <span>sales</span></span>` : ""}</span>
      </div>
      <div class="pos-kpis">
        ${kpi("Bags delivered", fmtN(m.entregue), `<span>of</span> ${fmtN(m.sacas)} <span>bags</span> · ${fmtN(m.ctr.size)} <span>contracts</span>${progresso(m)}`)}
        ${kpi("Bags to deliver", fmtN(m.aEntregar), `<span>${fmtN(m.abertos.size)} open contracts</span>${m.proximo ? ` · <span>next due</span> ${esc(fmtData(m.proximo.vencimento))}` : ""}`, m.aEntregar ? "cor-kpi-falta" : "")}
        ${kpi("Brokerage (est.)", reais(m.corretagem), `<span>on delivered</span> ${reais(m.corrEnt)} · <span>to deliver</span> ${reais(m.corrFalta)} · <span>avg rate</span> ${pctFmt(m.pct)}${avisoSemPreco(m)}`)}
        ${kpisPago(somaEspelhos(esp))}
      </div>

      <section class="pos-card">
        <div class="pos-card-h"><h2>Purchases and sales</h2></div>
        <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
          <thead><tr><th></th><th class="num">Contracts</th><th class="num">Bags</th><th class="num">Delivered</th><th class="num">To deliver</th><th class="num">Avg rate</th>
            <th class="num">Brokerage R$</th><th class="num">On delivered</th><th class="num">On to deliver</th></tr></thead>
          <tbody>${porTipo.map(([t, ls]) => linhaTipo(t === "PURCHASE" ? "Purchases" : "Sales", ls)).join("")}</tbody>
          ${porTipo.length > 1 ? `<tfoot>${linhaTipo("Total", c.linhas).replace("<tr>", `<tr class="total">`)}</tfoot>` : ""}
        </table></div>
      </section>

      <section class="pos-card">
        <div class="pos-card-h pos-card-h-linha"><div><h2>Contracts</h2>
          <p class="muted">${estado.aba === "aberto" ? "Still to deliver, by due date." : "Most recent first."} Brokerage = value × rate in Digisul (individual producer: value × 1.01).</p></div>
          ${segmentos("corAba", [["aberto", `To deliver (${fmtN(grupos.aberto.length)})`], ["entregue", `Delivered (${fmtN(grupos.entregue.length)})`],
            ...(grupos.cancelado.length ? [["cancelado", `Cancelled (${fmtN(grupos.cancelado.length)})`]] : []), ["todos", `All (${fmtN(c.linhas.length)})`]], estado.aba)}</div>
        ${tabelaContratos(ordenada, false)}
      </section>

      <div class="pos-duas">
        <section class="pos-card">
          <div class="pos-card-h"><h2>Brokerage statements</h2><p class="muted">From the Brokerage Statement: one per month and coffee. Purchases and sales together.</p></div>
          ${esp.length ? `<div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
            <thead><tr><th>Month</th><th>Coffee</th><th>Status</th><th>Statement no.</th><th class="num">Amount R$</th></tr></thead>
            <tbody>${esp.map((x) => `<tr><td>${esc(fmtMes(`${x.mes}-01`))}</td><td>${esc(x.especie === "TODOS" ? "Both" : cafeCurto(x.especie))}</td>
              <td><span class="${CLS_ESP[x.status] ?? "pill"}">${esc(STATUS_ESP[x.status] ?? x.status)}</span></td><td>${esc(x.espelho_numero || "—")}</td>
              <td class="num">${reais(x.espelho_valor)}</td></tr>`).join("")}</tbody>
          </table></div>` : `<p class="vazio-td">${espelhosErro ? "Statements unavailable." : "No statements for this broker yet."}</p>`}
        </section>
        <section class="pos-card">
          <div class="pos-card-h"><h2>Suppliers and clients</h2><p class="muted">Who this broker brought, by bags.</p></div>
          <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
            <thead><tr><th>Supplier / client</th><th>Type</th><th class="num">Contracts</th><th class="num">Bags</th><th class="num">To deliver</th><th class="num">Brokerage R$</th></tr></thead>
            <tbody>${topContra.map((o) => `<tr><td>${esc(o.nome)}</td><td>${TIPOS[o.tipo]}</td><td class="num">${fmtN(o.ctr.size)}</td><td class="num">${fmtN(o.sacas)}</td>
              <td class="num">${o.aEntregar ? fmtN(o.aEntregar) : `<span class="zero">–</span>`}</td><td class="num">${reais(o.corretagem)}</td></tr>`).join("")}</tbody>
          </table></div>
        </section>
      </div>`;
  };

  desenhar();
}
