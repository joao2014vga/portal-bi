// Certificados: página nativa do portal com a posição long/short de um
// certificado (começando pelo C.A.F.E. Practices) e os contratos certificados.
// Base: todas as compras e exportações gravadas pela sincronização com o Digisul
// (position-calc.js, certificadosDaApi) + ajustes manuais em bi_cert_ajustes —
// contratos encerrados que o Digisul não deixa mais editar.
//
// Páginas (link cadastrado em bi_dashboards):
//   portal:cert-cp   C.A.F.E. Practices
import { esc, $, $$, icon, toast, modal, confirmar, tempoRelativo } from "./ui.js";
import { fmtN, fmtMes, fmtData, segmentos, ligarSegmentos, vigiarNegativos, carregarXlsx } from "./position.js";

export const ehPainelCert = (link) => /^portal:cert-/.test(link ?? "");

// Contrato entra quando o certificador tem o certificado, mesmo junto com outros
// ("RAINFOREST ALIANCE,EUDR,CAFE PRATICES"). A exportação não preenche o CP no
// Digisul, então a venda também entra pelo cliente no Alertas ou na qualidade
// (`cliente`) ou pelo certificado escrito na descrição da qualidade (`descricao`,
// ex.: "C.A.F.E. PRACTICES VERIFIED") — regra conferida contra o Power BI.
const CERTS = {
  "portal:cert-cp": {
    // o controle começa em nov/26 com a sobra da planilha (aba History) como saldo inicial
    codigo: "CP", nome: "C.A.F.E. Practices", inicio: "2026-11",
    re: /\bCP\b|PRATIC|PRACTIC/i,
    // produtor que já passou do volume que pode ser usado: a sobra não entra no saldo
    // inicial e as compras dele não contam (dá para incluir uma a uma, se precisar)
    bloqueado: { re: /ALL?YSSON/i, nome: "Allysson" },
    venda: { cliente: /STARBUCK|\bSBUX\b|\bSTBX\b/i, descricao: /C\.?\s?A\.?\s?F\.?\s?E\.?\s+PRA[CT]?TICES|\bCP\b/i },
  },
};

const NOMES_MES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
// embarque como no Power BI: "NOVEMBER 2026"
const mesExtenso = (iso) => (iso ? `${NOMES_MES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : "—");
const hojeYm = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const mesAnterior = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
const soma = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const contratos = (n) => `${fmtN(n)} ${n === 1 ? "contract" : "contracts"}`;

// mês do movimento: compra pelo vencimento (como no Power BI; base antiga sem vencimento:
// entrega real, senão a prevista); venda pelo mês de embarque
const mesCompra = (r) => (r.vencimento ?? r.entrega ?? r.prev_entrega ?? r.emissao)?.slice(0, 7) ?? null;
const mesVenda = (r) => (r.embarque ?? r.data_bl ?? r.prev_carga ?? r.emissao)?.slice(0, 7) ?? null;
// cliente final da exportação: primeiro trecho do Alertas ("STARBUCKS - PO60029548 - SH101356")
const clienteDoAlerta = (r) => (r.alertas ? r.alertas.split(/\s+-\s+/)[0].trim() : null) || r.importador;

// Junta a base do Digisul com os ajustes manuais. Cada contrato ganha:
//   _auto  o certificado está no Digisul (_regra: pela regra das vendas) · _ajuste inclusão/exclusão manual
//   _conta entra na posição · _sacas quantidade considerada · _mes mês do movimento
function montar(base, ajustes, cert) {
  const aj = new Map(ajustes.map((a) => [`${a.tipo}|${a.contrato}`, a]));
  const usados = new Set();
  const preparar = (lista, tipo) => lista.map((r) => {
    const chave = `${tipo}|${r.contrato}`;
    const a = aj.get(chave) ?? null;
    if (a) usados.add(chave);
    const peloCertificado = cert.re.test(r.certificado ?? "");
    const regra = !peloCertificado && tipo === "venda" && !!cert.venda
      && (cert.venda.cliente.test(`${r.alertas ?? ""} ${r.qualidade ?? ""}`) || cert.venda.descricao.test(r.qualidade ?? ""));
    const bloqueado = tipo === "compra" && !!cert.bloqueado?.re.test(r.fornecedor ?? "");
    const auto = (peloCertificado || regra) && !bloqueado;
    const conta = a ? a.acao === "incluir" : auto;
    return {
      ...r, _tipo: tipo, _auto: auto, _regra: regra, _bloqueado: bloqueado && peloCertificado, _ajuste: a, _conta: conta,
      _sacas: conta && a?.sacas != null ? Number(a.sacas) : r.sacas,
      _mes: tipo === "compra" ? mesCompra(r) : mesVenda(r),
      ...(tipo === "venda" ? { _cliente: clienteDoAlerta(r) } : {}),
    };
  });
  // só contratos do mês de início do controle em diante
  const doInicio = (r) => !cert.inicio || (r._mes ?? "") >= cert.inicio;
  const compras = preparar(base.compras, "compra").filter(doInicio), vendas = preparar(base.vendas, "venda").filter(doInicio);
  // ajustes de contratos que não vêm mais do Digisul (renomeados ou apagados)
  const orfaos = ajustes.filter((a) => !usados.has(`${a.tipo}|${a.contrato}`));
  return { compras, vendas, orfaos };
}

// Histórico da planilha: sobra de cada compra BRC (sacas − usado). A sobra das
// compras vencidas antes do início do controle é o saldo inicial, menos a do
// produtor bloqueado; as que vencem depois entram pelo Digisul, no mês do vencimento.
function montarHistorico(historico, cert) {
  const linhas = (historico ?? []).map((h) => {
    const sobra = (Number(h.sacas) || 0) - (Number(h.usado) || 0);
    const bloqueado = !!cert.bloqueado?.re.test(h.fornecedor ?? "");
    const vencida = !cert.inicio || (h.vencimento ?? "").slice(0, 7) < cert.inicio;
    return { ...h, _sobra: sobra, _bloqueado: bloqueado, _vencida: vencida, _inicial: vencida && !bloqueado ? sobra : 0, _produtor: produtor(h.fornecedor) };
  });
  const porProdutor = new Map();
  for (const h of linhas) {
    const p = porProdutor.get(h._produtor) ?? porProdutor.set(h._produtor, { nome: h._produtor, n: 0, sacas: 0, usado: 0, sobra: 0, estoque: 0, futuro: 0, inicial: 0, bloqueado: h._bloqueado }).get(h._produtor);
    p.n++; p.sacas += Number(h.sacas) || 0; p.usado += Number(h.usado) || 0; p.sobra += h._sobra; p.inicial += h._inicial;
    if (h._vencida) p.estoque += h._sobra; else p.futuro += h._sobra;
  }
  const produtores = [...porProdutor.values()].sort((a, b) => b.estoque - a.estoque || a.nome.localeCompare(b.nome));
  return { linhas, produtores, inicial: soma(linhas, "_inicial"), excluido: soma(linhas.filter((h) => h._vencida && h._bloqueado), "_sobra") };
}
// mesmo produtor com grafias diferentes ("PRIMAVERA AGRONEGOCIOS" e "… LTDA")
const produtor = (s) => String(s ?? "—").toUpperCase().replace(/[.,]/g, " ").replace(/\b(LTDA|S\s*A|ME|EIRELI|E OUTROS)\b/g, "").replace(/\s+/g, " ").trim() || "—";

// Posição por mês: comprado, vendido e saldo acumulado (a partir do saldo inicial), sem pular meses
function posicaoMensal(compras, vendas, inicial = 0, inicio = null) {
  const meses = new Map();
  const linha = (ym) => meses.get(ym) ?? meses.set(ym, { ym, compras: 0, vendas: 0, nc: 0, nv: 0 }).get(ym);
  for (const r of compras) if (r._mes) { const l = linha(r._mes); l.compras += r._sacas ?? 0; l.nc++; }
  for (const r of vendas) if (r._mes) { const l = linha(r._mes); l.vendas += r._sacas ?? 0; l.nv++; }
  if (inicial && inicio) linha(inicio);
  if (!meses.size) return [];
  const chaves = [...meses.keys()].sort();
  const lista = [];
  let [y, m] = chaves[0].split("-").map(Number);
  const fim = chaves[chaves.length - 1];
  let acum = inicial;
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const l = meses.get(ym) ?? { ym, compras: 0, vendas: 0, nc: 0, nv: 0 };
    l.saldo = l.compras - l.vendas;
    acum += l.saldo;
    l.acumulado = acum;
    lista.push(l);
    if (ym >= fim) break;
    if (++m > 12) { m = 1; y++; }
  }
  return lista;
}

const COLS = {
  compra: [["contrato", "Contract"], ["fornecedor", "Supplier"], ["_mes", "Month", "m"], ["vencimento", "Due date", "d"], ["_sacas", "Bags", "n"],
    ["entregue", "Delivered", "n"], ["a_entregar", "To deliver", "n"], ["padrao", "Quality"], ["safra", "Crop"],
    ["diferencial", "Diff", "n2"], ["preco", "Price R$/bag", "n2"], ["valor", "Value R$", "n"], ["certificado", "Certificate"]],
  venda: [["contrato", "Contract"], ["_cliente", "Client (alert)"], ["importador", "Importer"], ["embarque", "Shipment", "e"],
    ["data_bl", "B/L date", "d"], ["_sacas", "Bags", "n"], ["saldo", "To ship", "n"], ["padrao", "Quality"],
    ["diferencial", "Diff", "n2"], ["vlr_final", "Final price", "n2"], ["unidade", "Unit"], ["valor_usd", "Value US$", "n"],
    ["certificado", "Certificate"], ["alertas", "Alert"]],
};
const COLS_HIST = [["compra", "BRC contract"], ["id_cert", "CP ID"], ["fornecedor", "Producer"], ["fazenda", "Farm"],
  ["vencimento", "Due date", "d"], ["sacas", "Bags", "n"], ["usado", "Used", "n"], ["_sobra", "Leftover", "n"]];
const NUMERICOS = ["n", "n2"];

const cabecalho = (cols, ordem) => cols.map(([k, rot, tipo]) => `<th class="${NUMERICOS.includes(tipo) ? "num" : ""}"><button type="button" class="ordenar" data-ordem="${k}">${esc(rot)}${ordem?.[0] === k ? (ordem[1] > 0 ? " ▲" : " ▼") : ""}</button></th>`).join("");
// ordem = [coluna, 1 | -1] escolhida no cabeçalho; sem ela, a ordem padrão da aba
const ordenar = (linhas, ordem, padrao) => [...linhas].sort(ordem
  ? (a, b) => {
    const [k, dir] = ordem, x = a[k], y = b[k];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true })) * dir;
  }
  : padrao);

function celula(r, k, tipo) {
  const v = r[k];
  const num = NUMERICOS.includes(tipo);
  const txt = v == null || v === "" ? "—" : tipo === "n" ? fmtN(v) : tipo === "n2" ? fmtN(v, 2) : tipo === "d" ? fmtData(v)
    : tipo === "m" ? fmtMes(v + "-01") : tipo === "e" ? mesExtenso(v) : v;
  const titulo = k === "_cliente" || k === "alertas" ? r.alertas : k === "certificado" ? v : null;
  return `<td class="${num ? "num" : ""} ${num && v < 0 ? "neg" : ""}" ${titulo ? `title="${esc(titulo)}"` : ""}>${esc(txt)}</td>`;
}

function origem(r) {
  if (r._ajuste?.acao === "excluir") return `<span class="pill pill-critico" title="${esc(quemLancou(r._ajuste))}">Excluded</span>`;
  if (r._ajuste) {
    const parcial = r._ajuste.sacas != null ? ` · ${fmtN(r._ajuste.sacas)} bags` : "";
    return `<span class="pill pill-alerta" title="${esc(quemLancou(r._ajuste))}">Manual${parcial}</span>`;
  }
  return r._regra ? `<span class="pill" title="Export without the certificate in Digisul, counted by the client or quality description">Digisul · rule</span>` : `<span class="pill">Digisul</span>`;
}
const quemLancou = (a) => [a.autor, a.created_at ? fmtData(a.created_at.slice(0, 10)) : null, a.obs].filter(Boolean).join(" · ");

// =====================================================================
// PÁGINA
// =====================================================================
// ctx = { api, gerente (pode lançar ajustes), admin, recarregar }
export async function renderCert(link, alvo, ctx) {
  vigiarNegativos(alvo);
  const cert = CERTS[link];
  if (!cert) { alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Unknown certificate page</h3></div>`; return; }
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading certificate…</div>`;
  let base, ajustes, historico;
  try {
    [base, ajustes, historico] = await Promise.all([ctx.api.certBase(), ctx.api.certAjustes(cert.codigo), ctx.api.certHistorico(cert.codigo)]);
  } catch (e) {
    alvo.innerHTML = `<div class="vazio">${icon("lock")}<h3>Certificate data is not available</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (!base) {
    alvo.innerHTML = `<div class="pos"><div class="vazio">${icon("chart")}<h3>No Digisul data yet</h3>
      <p>The purchases and export sales come from the Digisul update, every 2 hours on business days.${ctx.gerente ? " Click “Update now” to load them." : ""}</p>
      ${ctx.gerente ? `<button class="btn btn-primary" id="certSync">${icon("refresh")}<span>Update now</span></button>` : ""}</div></div>`;
    ligarSync(alvo, ctx);
    return;
  }

  const { compras, vendas, orfaos } = montar(base, ajustes, cert);
  const cc = compras.filter((r) => r._conta), vc = vendas.filter((r) => r._conta);
  const hist = montarHistorico(historico, cert);
  const inicial = hist.inicial;
  const meses = posicaoMensal(cc, vc, inicial, cert.inicio);
  const atual = hojeYm();
  const ateHoje = meses.filter((l) => l.ym <= atual);
  const saldoHoje = ateHoje.length ? ateHoje[ateHoje.length - 1].acumulado : inicial;
  const saldoFinal = meses.length ? meses[meses.length - 1].acumulado : inicial;
  const pior = meses.reduce((p, l) => (l.ym >= atual && (!p || l.acumulado < p.acumulado) ? l : p), null);
  const fimHistorico = cert.inicio ? fmtMes(mesAnterior(cert.inicio) + "-01") : null;
  // exportações do Digisul, para mostrar embarque e cliente nos vínculos do histórico
  const vendaPorContrato = new Map(base.vendas.map((r) => [r.contrato, { mes: mesVenda(r), cliente: clienteDoAlerta(r) }]));

  let aba = "compra", busca = "", mes = "", fonte = "", ordem = null;

  const desenhar = () => {
    const todas = aba === "venda" ? vendas : compras;
    const t = busca.trim().toLowerCase();
    const cols = COLS[aba];
    const abas = segmentos("certAba", [["compra", `Purchases (${cc.length})`], ["venda", `Export sales (${vc.length})`],
      ["historico", `History (${hist.linhas.length})`]], aba);

    alvo.innerHTML = `<div class="pos">
      <div class="pos-topo">
        <div class="pos-data">${icon("clock")}<span>${esc(cert.nome)} · Digisul data updated <strong>${esc(tempoRelativo(base.atualizado_em))}</strong></span>
          ${cert.inicio ? `<span class="muted">· contracts starting <span>${esc(fmtMes(cert.inicio + "-01"))}</span></span>` : ""}
          <span class="muted">· all figures in 60 kg bags</span></div>
        ${ctx.gerente ? `<div class="pos-acoes">
          <button class="btn" id="certSync" title="Fetch Digisul now">${icon("refresh")}<span>Update now</span></button>
          <button class="btn btn-primary" id="certIncluir">${icon("plus")}<span>Include contract</span></button>
        </div>` : ""}
      </div>

      ${orfaos.length ? `<div class="aviso-inline alerta">${icon("alert")}<span>Included or excluded manually but no longer found in Digisul: <strong>${esc(orfaos.map((a) => a.contrato).join(", "))}</strong></span></div>` : ""}
      ${cert.inicio && !hist.linhas.length ? `<div class="aviso-inline alerta">${icon("alert")}<span>${historico === null
        ? "The opening stock comes from the history spreadsheet: run section 13 of supabase/schema.sql in the Supabase SQL Editor, then import it in the History tab."
        : "No history imported yet, so the position starts at zero. Import the control spreadsheet in the History tab."}</span></div>` : ""}

      <div class="pos-kpis">
        ${cert.inicio ? kpi("Opening stock", fmtN(inicial), `end of <span>${esc(fimHistorico)}</span>${cert.bloqueado && hist.excluido ? ` · excl. <span>${esc(cert.bloqueado.nome)}</span>` : ""}`) : ""}
        ${kpi("Purchased", fmtN(soma(cc, "_sacas")), contratos(cc.length))}
        ${kpi("Sold (export)", fmtN(soma(vc, "_sacas")), contratos(vc.length))}
        ${kpi("Balance today", fmtN(saldoHoje), `up to <span>${esc(fmtMes(atual + "-01"))}</span> · ${saldoHoje < 0 ? "short" : "long"}`)}
        ${kpi("Final balance", fmtN(saldoFinal), meses.length ? `after <span>${esc(fmtMes(meses[meses.length - 1].ym + "-01"))}</span>` : "—")}
        ${pior ? kpi("Lowest balance ahead", fmtN(pior.acumulado), `in <span>${esc(fmtMes(pior.ym + "-01"))}</span>`, pior.acumulado < 0 ? "pos-kpi-critico" : "") : ""}
      </div>

      <div class="pos-card">
        <div class="pos-card-h pos-card-h-linha"><div><h2>Long / short by month</h2>
          <p class="muted">Purchases by due month · export sales by shipment month · running balance. Click a month to see its contracts.</p></div>
          ${mes ? `<button type="button" class="link" id="certLimparMes">${icon("x")}Show all months</button>` : ""}</div>
        <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
          <thead><tr><th>Month</th><th class="num">Purchases</th><th class="num">Sales</th><th class="num">Net</th><th class="num">Running balance</th></tr></thead>
          <tbody>${inicial ? `<tr class="cert-abertura" title="Leftover of the purchases in the history spreadsheet due before the control starts"><td>Opening stock <span class="muted">· end of <span>${esc(fimHistorico)}</span></span></td>
            <td></td><td></td><td></td>${num(inicial, true)}</tr>` : ""}
            ${meses.length ? meses.map((l) => `<tr class="clicavel ${l.ym === mes ? "linha-sel" : ""}" data-mes="${l.ym}" ${l.ym === atual ? `title="Current month"` : ""}>
            <td>${l.ym === atual ? "<strong>" : ""}${esc(fmtMes(l.ym + "-01"))}${l.ym === atual ? "</strong> <span class=\"muted\">· today</span>" : ""}</td>
            ${num(l.compras)}${num(-l.vendas)}${num(l.saldo)}${num(l.acumulado, true)}</tr>`).join("")
            : `<tr><td colspan="5" class="vazio-td">No ${esc(cert.codigo)} contracts yet.</td></tr>`}</tbody>
          ${meses.length ? `<tfoot><tr><td>Total</td>${num(soma(meses, "compras"))}${num(-soma(meses, "vendas"))}${num(saldoFinal - inicial)}${num(saldoFinal, true)}</tr></tfoot>` : ""}
        </table></div>
      </div>

      ${aba === "historico" ? corpoHistorico(abas, t) : corpoContratos(abas, todas, cols, t)}
    </div>`;

    ligarSync(alvo, ctx);
    ligarSegmentos(alvo, "certAba", (k) => { aba = k; ordem = null; desenhar(); });
    const fb = $("#certBusca", alvo);
    fb.addEventListener("input", () => { busca = fb.value; desenhar(); const n = $("#certBusca", alvo); n.focus(); n.setSelectionRange(busca.length, busca.length); });
    $("#certMes", alvo)?.addEventListener("change", (e) => { mes = e.target.value; desenhar(); });
    $("#certFonte", alvo)?.addEventListener("change", (e) => { fonte = e.target.value; desenhar(); });
    $("#certLimparMes", alvo)?.addEventListener("click", () => { mes = ""; desenhar(); });
    $$("[data-mes]", alvo).forEach((tr) => tr.addEventListener("click", () => {
      mes = mes === tr.dataset.mes ? "" : tr.dataset.mes;
      // vai para a aba que tem contratos no mês escolhido
      const l = meses.find((x) => x.ym === mes);
      if (aba === "historico") aba = "compra";
      if (l && !(aba === "compra" ? l.nc : l.nv)) aba = aba === "compra" ? "venda" : "compra";
      desenhar();
    }));
    $$("[data-ordem]", alvo).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.ordem;
      ordem = ordem?.[0] === k ? (ordem[1] > 0 ? [k, -1] : null) : [k, 1];
      desenhar();
    }));
    $("#certIncluir", alvo)?.addEventListener("click", () => abrirInclusao(compras, vendas, cert, ctx));
    $("#certImportar", alvo)?.addEventListener("click", () => abrirImportacao(cert, ctx, hist.linhas.length));
    $$("[data-acao]", alvo).forEach((b) => b.addEventListener("click", () => executarAcao(b.dataset, todas, cert, ctx)));
  };

  // Abas Purchases / Export sales: contratos que contam para o certificado
  const corpoContratos = (abas, todas, cols, t) => {
    let linhas = todas.filter((r) => (fonte === "excluido" ? r._ajuste?.acao === "excluir"
      : r._conta && (!fonte || (fonte === "manual" ? !!r._ajuste : !r._ajuste))))
      .filter((r) => (!mes || r._mes === mes)
        && (!t || [r.contrato, r.fornecedor, r.importador, r.alertas, r.padrao, r.certificado, r.safra].some((x) => String(x ?? "").toLowerCase().includes(t))));
    linhas = ordenar(linhas, ordem, (a, b) => String(a._mes ?? "").localeCompare(String(b._mes ?? "")) || a.contrato.localeCompare(b.contrato, "en", { numeric: true }));
    const nExcl = todas.filter((r) => r._ajuste?.acao === "excluir").length;
    return `<div class="pos-filtros">
        ${abas}
        <label class="busca sm">${icon("search")}<input type="search" id="certBusca" placeholder="Search contract, supplier, client…" value="${esc(busca)}"></label>
        <select id="certMes" aria-label="Month"><option value="">All months</option>${meses.filter((l) => (aba === "compra" ? l.nc : l.nv)).map((l) =>
          `<option value="${l.ym}" ${l.ym === mes ? "selected" : ""}>${esc(fmtMes(l.ym + "-01"))}</option>`).join("")}</select>
        <select id="certFonte" aria-label="Source"><option value="">Digisul + manual</option>
          <option value="digisul" ${fonte === "digisul" ? "selected" : ""}>Digisul only</option>
          <option value="manual" ${fonte === "manual" ? "selected" : ""}>Included manually</option>
          ${nExcl ? `<option value="excluido" ${fonte === "excluido" ? "selected" : ""}>Excluded (${nExcl})</option>` : ""}</select>
      </div>
      <div class="pos-resumo">
        <span><strong>${fmtN(linhas.length)}</strong> ${linhas.length === 1 ? "contract" : "contracts"}</span>
        <span><strong>${fmtN(soma(linhas, "_sacas"))}</strong> bags</span>
        ${aba === "venda" ? `<span><strong>${fmtN(soma(linhas, "saldo"))}</strong> bags to ship</span>` : `<span><strong>${fmtN(soma(linhas, "a_entregar"))}</strong> bags to deliver</span>`}
      </div>
      <div class="tabela-wrap pos-tabela pos-contratos"><table class="tabela tabela-num">
        <thead><tr>${cabecalho(cols, ordem)}<th>Source</th>${ctx.gerente ? "<th></th>" : ""}</tr></thead>
        <tbody>${linhas.length ? linhas.map((r) => `<tr>${cols.map(([k, , tipo]) => celula(r, k, tipo)).join("")}<td>${origem(r)}</td>
          ${ctx.gerente ? `<td>${acao(r)}</td>` : ""}</tr>`).join("")
          : `<tr><td colspan="${cols.length + 1 + (ctx.gerente ? 1 : 0)}" class="vazio-td">No contracts match these filters.</td></tr>`}</tbody>
      </table></div>`;
  };

  // Aba History: a planilha de controle, compra BRC por compra BRC, com as
  // exportações que ela abasteceu e a sobra; em cima, o resumo por produtor
  const corpoHistorico = (abas, t) => {
    let linhas = hist.linhas.filter((h) => !t || [h.compra, h.id_cert, h.fornecedor, h.fazenda, ...h.vinculos.map((v) => v.venda)]
      .some((x) => String(x ?? "").toLowerCase().includes(t)));
    linhas = ordenar(linhas, ordem, (a, b) => a.ordem - b.ordem);
    const importado = hist.linhas[0];
    const p = hist.produtores;
    return `<div class="pos-filtros">
        ${abas}
        <label class="busca sm">${icon("search")}<input type="search" id="certBusca" placeholder="Search contract, producer, export…" value="${esc(busca)}"></label>
        ${ctx.gerente ? `<button class="btn" id="certImportar">${icon("upload")}<span>Import spreadsheet</span></button>` : ""}
      </div>
      ${!hist.linhas.length ? `<div class="vazio">${icon("file")}<h3>No history imported</h3>
        <p>Import the Controle CAFE Pratices spreadsheet (CONTROLE sheet): each BRC purchase, the exports it went to and the leftover.</p></div>` : `
      <p class="muted pos-nota">${esc(["Spreadsheet imported", importado.importado_por, fmtData(importado.created_at.slice(0, 10))].filter(Boolean).join(" · "))}</p>
      <p class="muted pos-nota">
The leftover of the purchases due before the control starts is the opening stock; later purchases come from Digisul in their due month.</p>
      <div class="pos-card">
        <div class="pos-card-h"><h2>By producer</h2></div>
        <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
          <thead><tr><th>Producer</th><th class="num">Contracts</th><th class="num">Bags</th><th class="num">Used</th><th class="num">Leftover due</th><th class="num">Not due yet</th><th class="num">Opening stock</th></tr></thead>
          <tbody>${p.map((x) => `<tr><td>${esc(x.nome)}${x.bloqueado ? ` <span class="pill pill-critico" title="Over the volume we can use: the leftover is not counted">Over limit</span>` : ""}</td>
            <td class="num">${fmtN(x.n)}</td>${num(x.sacas)}${num(x.usado)}${num(x.estoque)}${num(x.futuro)}${num(x.inicial, true)}</tr>`).join("")}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${fmtN(soma(p, "n"))}</td>${num(soma(p, "sacas"))}${num(soma(p, "usado"))}${num(soma(p, "estoque"))}${num(soma(p, "futuro"))}${num(inicial, true)}</tr></tfoot>
        </table></div>
      </div>
      <div class="pos-resumo">
        <span><strong>${fmtN(linhas.length)}</strong> ${linhas.length === 1 ? "contract" : "contracts"}</span>
        <span><strong>${fmtN(soma(linhas, "sacas"))}</strong> bags</span>
        <span><strong>${fmtN(soma(linhas, "usado"))}</strong> used</span>
        <span><strong>${fmtN(soma(linhas, "_sobra"))}</strong> leftover</span>
      </div>
      <div class="tabela-wrap pos-tabela pos-contratos"><table class="tabela tabela-num">
        <thead><tr>${cabecalho(COLS_HIST, ordem)}<th>Exports</th></tr></thead>
        <tbody>${linhas.length ? linhas.map((h) => `<tr class="${h._bloqueado ? "cert-bloqueado" : ""}">${COLS_HIST.map(([k, , tipo]) => celula(h, k, tipo)).join("")}
          <td class="cert-vinculos">${h.vinculos.length ? h.vinculos.map((v) => {
            const d = vendaPorContrato.get(v.venda);
            const dica = d ? [d.cliente, d.mes ? mesExtenso(d.mes + "-01") : null].filter(Boolean).join(" · ") : "Not found in Digisul";
            return `<span title="${esc(dica)}">${esc(v.venda)} <strong>${fmtN(v.sacas)}</strong></span>`;
          }).join("") : `<span class="muted">—</span>`}</td></tr>`).join("")
          : `<tr><td colspan="${COLS_HIST.length + 1}" class="vazio-td">No contracts match the search.</td></tr>`}</tbody>
      </table></div>`}`;
  };
  desenhar();
}

// `sub` é HTML (o mês fica num elemento à parte, para a tradução da tela)
const kpi = (titulo, valor, sub, cls = "") => `<div class="pos-kpi pos-kpi-est ${cls}">
  <span class="pos-kpi-t">${esc(titulo)}</span><span class="pos-kpi-v">${esc(valor)}</span><span class="pos-kpi-s">${sub}</span></div>`;
const num = (v, forte = false) => `<td class="num ${v < 0 ? "neg" : ""} ${forte ? "forte" : ""}">${Math.abs(v) < 0.5 ? `<span class="zero">–</span>` : fmtN(v)}</td>`;

// ações por contrato (só quem pode lançar ajustes)
function acao(r) {
  const b = (a, rot, ic) => `<button type="button" class="link" data-acao="${a}" data-contrato="${esc(r.contrato)}">${icon(ic)}${rot}</button>`;
  if (r._ajuste?.acao === "excluir") return b("restaurar", "Restore", "refresh");
  if (r._ajuste) return b("remover", "Remove", "trash");
  return b("excluir", "Exclude", "x");
}

async function executarAcao({ acao: a, contrato }, todas, cert, ctx) {
  const r = todas.find((x) => x.contrato === contrato);
  if (!r) return;
  try {
    if (a === "excluir") {
      const ok = await confirmar("Exclude contract", `<strong>${esc(contrato)}</strong><br>Remove this contract from the ${esc(cert.codigo)} position? Digisul still shows the certificate; only the portal changes.`, "Exclude");
      if (!ok) return;
      await ctx.api.salvarCertAjuste({ certificado: cert.codigo, tipo: r._tipo, contrato, acao: "excluir" });
      toast(`Contract excluded from the ${cert.codigo} position.`);
    } else {
      const ok = await confirmar(a === "restaurar" ? "Restore contract" : "Remove manual inclusion",
        `<strong>${esc(contrato)}</strong><br>${a === "restaurar" ? `Count this contract in the ${esc(cert.codigo)} position again, as in Digisul?`
          : `Remove this contract from the ${esc(cert.codigo)} position?`}`, a === "restaurar" ? "Restore" : "Remove");
      if (!ok) return;
      await ctx.api.removerCertAjuste(r._ajuste.id);
      toast(a === "restaurar" ? "Contract restored." : `Contract removed from the ${cert.codigo} position.`);
    }
    ctx.recarregar();
  } catch (e) { toast(e.message, "erro"); }
}

function ligarSync(alvo, ctx) {
  $("#certSync", alvo)?.addEventListener("click", async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.querySelector("span").textContent = "Updating…";
    try {
      await ctx.api.sincronizarPosition();
      toast("Certificate data updated from Digisul.");
      ctx.recarregar();
    } catch (e) {
      toast(e.message, "erro");
      b.disabled = false;
      b.querySelector("span").textContent = "Update now";
    }
  });
}

// Inclusão manual: busca qualquer compra ou exportação que ainda não conta para o certificado
function abrirInclusao(compras, vendas, cert, ctx) {
  const fora = [...compras, ...vendas].filter((r) => !r._conta);
  let escolhido = null;
  const resultado = (t) => {
    const q = t.trim().toLowerCase();
    if (q.length < 2) return `<p class="muted pos-nota">Type at least 2 characters of the contract, supplier or client.</p>`;
    const achados = fora.filter((r) => [r.contrato, r.fornecedor, r.importador, r.alertas].some((x) => String(x ?? "").toLowerCase().includes(q))).slice(0, 40);
    if (!achados.length) return `<p class="muted pos-nota">No contract found outside the ${esc(cert.codigo)} position.</p>`;
    return `<div class="tabela-wrap pos-tabela cert-lista"><table class="tabela tabela-num">
      <thead><tr><th></th><th>Contract</th><th>Type</th><th>Supplier / client</th><th>Month</th><th class="num">Bags</th><th>Certificate</th></tr></thead>
      <tbody>${achados.map((r) => {
        const id = `${r._tipo}|${r.contrato}`;
        return `<tr class="clicavel" data-escolher="${esc(id)}"><td><input type="radio" name="contrato" value="${esc(id)}" ${escolhido === id ? "checked" : ""} aria-label="${esc(r.contrato)}"></td>
          <td>${esc(r.contrato)}</td><td>${r._tipo === "compra" ? "Purchase" : "Export sale"}</td>
          <td>${esc(r._tipo === "compra" ? r.fornecedor ?? "—" : r._cliente ?? "—")}</td><td>${esc(r._mes ? fmtMes(r._mes + "-01") : "—")}</td>
          <td class="num">${fmtN(r.sacas)}</td><td>${esc(r.certificado ?? "—")}${r._ajuste?.acao === "excluir" ? " · <span class=\"pill pill-critico\">Excluded</span>" : ""}${r._bloqueado ? " · <span class=\"pill pill-critico\">Over limit</span>" : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  };
  modal({
    titulo: `Include contract in ${cert.codigo}`,
    botao: "Include",
    largura: "modal-lg",
    corpo: `<p class="muted">For contracts that received the ${esc(cert.nome)} certificate after they were closed, when Digisul no longer allows the change.
      Only the portal changes; the inclusion is recorded with your name.</p>
      <label class="busca">${icon("search")}<input type="search" id="incBusca" placeholder="Search contract, supplier, client…" autocomplete="off"></label>
      <div id="incResultado">${resultado("")}</div>
      <div class="cert-inc-campos">
        <label class="campo"><span>Bags (optional)</span><input type="number" name="sacas" min="0" step="0.01" placeholder="Whole contract"></label>
        <label class="campo"><span>Note</span><input type="text" name="obs" maxlength="200" placeholder="e.g. certificate issued after delivery"></label>
      </div>`,
    onOpen(form) {
      const box = $("#incResultado", form);
      const marcar = () => $$("[data-escolher]", box).forEach((tr) => tr.addEventListener("click", () => {
        escolhido = tr.dataset.escolher;
        $$("input[name=contrato]", box).forEach((i) => { i.checked = i.value === escolhido; });
      }));
      $("#incBusca", form).addEventListener("input", (e) => { box.innerHTML = resultado(e.target.value); marcar(); });
    },
    async onSubmit(form) {
      if (!escolhido) throw new Error("Choose a contract from the list.");
      const [tipo, contrato] = [escolhido.slice(0, escolhido.indexOf("|")), escolhido.slice(escolhido.indexOf("|") + 1)];
      const sacas = form.sacas.value === "" ? null : Number(form.sacas.value);
      if (sacas != null && !(sacas > 0)) throw new Error("Bags must be greater than zero, or leave it empty for the whole contract.");
      await ctx.api.salvarCertAjuste({ certificado: cert.codigo, tipo, contrato, acao: "incluir", sacas, obs: form.obs.value.trim() || null });
      toast(`Contract included in the ${cert.codigo} position.`);
      ctx.recarregar();
    },
  });
}

// Lê a aba CONTROLE da planilha "Controle CAFE Pratices": uma linha por compra BRC
// (contrato, ID do certificado, fornecedor, fazenda, sacas, vencimento, usado) e,
// nas colunas BRAS-…, as sacas que saíram em cada exportação.
export async function lerHistoricoCert(file) {
  const XLSX = await carregarXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", sheets: ["CONTROLE"], cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
  const ws = wb.Sheets.CONTROLE;
  if (!ws) throw new Error("Sheet CONTROLE not found. Is this the C.A.F.E. Practices control spreadsheet?");
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const iCab = g.findIndex((l) => l.some((c) => /^contrato$/i.test(String(c ?? "").trim())));
  if (iCab < 0) throw new Error("Header with the “Contrato” column not found in the CONTROLE sheet.");
  const cab = g[iCab].map((c) => String(c ?? "").trim());
  const col = (re) => cab.findIndex((c) => re.test(c));
  const c = { compra: col(/^contrato$/i), id: col(/^id\b/i), forn: col(/^fornecedor/i), sacas: col(/^sacas/i), usado: col(/^usado/i), venc: col(/^vencimento/i) };
  if (c.forn < 0 || c.sacas < 0) throw new Error("Columns “Fornecedor” and “Sacas contrato” not found in the CONTROLE sheet.");
  const vendas = cab.map((t, i) => (/^BRAS-?\s*\d/i.test(t) ? { i, venda: contratoBras(t) } : null)).filter(Boolean);
  const n = (v) => (typeof v === "number" ? v : Number(String(v ?? "").replace(",", ".")) || 0);
  const iso = (v) => (typeof v === "number" ? new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) : null);
  const linhas = [];
  for (let r = iCab + 1; r < g.length; r++) {
    const l = g[r], compra = String(l[c.compra] ?? "").trim();
    if (!/^BRC/i.test(compra)) continue;
    const vinculos = vendas.map(({ i, venda }) => ({ venda, sacas: n(l[i]) })).filter((v) => Math.abs(v.sacas) >= 0.5);
    const usado = c.usado >= 0 && l[c.usado] != null ? n(l[c.usado]) : vinculos.reduce((s, v) => s + v.sacas, 0);
    linhas.push({
      ordem: r + 1, compra, id_cert: String(l[c.id] ?? "").trim() || null,
      fornecedor: String(l[c.forn] ?? "").trim() || null, fazenda: String(l[c.forn + 1] ?? "").trim() || null,
      sacas: n(l[c.sacas]), usado, vencimento: c.venc >= 0 ? iso(l[c.venc]) : null, vinculos,
    });
  }
  if (!linhas.length) throw new Error("No BRC purchase contract found in the CONTROLE sheet.");
  return linhas;
}
// "BRAS-191/26-2" → "BRAS-0191/26-2", como no Digisul
const contratoBras = (s) => s.toUpperCase().replace(/\s+/g, "").replace(/^BRAS-?(\d+)/, (_, d) => `BRAS-${d.padStart(4, "0")}`);

function abrirImportacao(cert, ctx, atuais) {
  modal({
    titulo: `Import ${cert.codigo} history`,
    botao: "Read and import",
    corpo: `<p class="muted">Choose the Controle CAFE Pratices spreadsheet (.xlsx). The CONTROLE sheet is read in your browser:
      each BRC purchase, the exports it went to and the leftover.</p>
      ${atuais ? `<p class="muted">It replaces the ${fmtN(atuais)} contracts imported before.</p>` : ""}
      <label class="campo"><span>Spreadsheet *</span><input type="file" name="arquivo" accept=".xlsx,.xlsm" required></label>`,
    async onSubmit(f) {
      const file = f.arquivo.files[0];
      if (!file) throw new Error("Please choose the spreadsheet.");
      const linhas = await lerHistoricoCert(file);
      await ctx.api.importarCertHistorico(cert.codigo, linhas);
      toast(`History imported: ${fmtN(linhas.length)} purchase contracts.`);
      ctx.recarregar();
    },
  });
}
