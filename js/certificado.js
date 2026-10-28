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
import { t as traduzir } from "./i18n.js";

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
const abaAberta = new Map(), buscaAberta = new Map();
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

// Histórico das compras BRC com o certificado: as linhas gravadas (importadas da
// planilha ou incluídas pela tela) e, sozinhas, as compras que o Digisul traz a
// partir do início do controle. Sobra = sacas − usado antes do portal − sacas
// vinculadas pela tela. A sobra das compras vencidas antes do início é o saldo
// inicial, menos a do produtor bloqueado; as que vencem depois entram na posição
// pelo Digisul, no mês do vencimento.
function montarHistorico(historico, vinculos, compras, cert) {
  const novos = (vinculos ?? []).map((v) => ({ ...v, sacas: Number(v.sacas) || 0 }));
  const gravadas = (historico ?? []).map((h) => ({ ...h, _chave: `h:${h.id}`, _origem: h.origem ?? "planilha",
    _novos: novos.filter((v) => v.historico_id === h.id) }));
  const nomes = new Set(gravadas.map((h) => h.compra));
  const doDigisul = compras.filter((r) => r._conta && !nomes.has(r.contrato)).map((r) => ({
    compra: r.contrato, fornecedor: r.fornecedor, sacas: r._sacas, usado: 0, vencimento: r.vencimento, vinculos: [],
    _chave: `d:${r.contrato}`, _origem: "digisul", _novos: novos.filter((v) => v.historico_id == null && v.compra === r.contrato) }));
  const linhas = [...gravadas, ...doDigisul].map((h) => {
    const antes = (Number(h.sacas) || 0) - (Number(h.usado) || 0);
    const vinculado = soma(h._novos, "sacas");
    const bloqueado = !!cert.bloqueado?.re.test(h.fornecedor ?? "");
    const vencida = !cert.inicio || (h.vencimento ?? "").slice(0, 7) < cert.inicio;
    return { ...h, _usado: (Number(h.usado) || 0) + vinculado, _sobra: antes - vinculado, _bloqueado: bloqueado, _vencida: vencida,
      _inicial: vencida && !bloqueado && h._origem !== "digisul" ? antes : 0, _produtor: produtor(h.fornecedor) };
  });
  const porProdutor = new Map();
  for (const h of linhas) {
    const p = porProdutor.get(h._produtor) ?? porProdutor.set(h._produtor, { nome: h._produtor, n: 0, sacas: 0, usado: 0, sobra: 0, estoque: 0, futuro: 0, inicial: 0, bloqueado: h._bloqueado }).get(h._produtor);
    p.n++; p.sacas += Number(h.sacas) || 0; p.usado += h._usado; p.sobra += h._sobra; p.inicial += h._inicial;
    if (h._vencida) p.estoque += h._sobra; else p.futuro += h._sobra;
  }
  const produtores = [...porProdutor.values()].sort((a, b) => b.estoque - a.estoque || a.nome.localeCompare(b.nome));
  // sacas de cada exportação que já têm origem: as da planilha e as vinculadas pela tela
  const porVenda = new Map();
  for (const h of linhas) {
    for (const v of h.vinculos ?? []) porVenda.set(v.venda, (porVenda.get(v.venda) ?? 0) + (Number(v.sacas) || 0));
    for (const v of h._novos) porVenda.set(v.venda, (porVenda.get(v.venda) ?? 0) + v.sacas);
  }
  return { linhas, produtores, porVenda, novos, gravadas: gravadas.length, inicial: soma(linhas, "_inicial"),
    excluido: soma(linhas.filter((h) => h._vencida && h._bloqueado), "_sobra") };
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
    ["data_bl", "B/L date", "d"], ["_sacas", "Bags", "n"], ["_vinculado", "From BRC", "n"], ["saldo", "To ship", "n"], ["padrao", "Quality"],
    ["diferencial", "Diff", "n2"], ["vlr_final", "Final price", "n2"], ["unidade", "Unit"], ["valor_usd", "Value US$", "n"],
    ["certificado", "Certificate"], ["alertas", "Alert"]],
};
const COLS_HIST = [["compra", "BRC contract"], ["id_cert", "CP ID"], ["fornecedor", "Producer"], ["fazenda", "Farm"],
  ["vencimento", "Due date", "d"], ["sacas", "Bags", "n"], ["_usado", "Used", "n"], ["_sobra", "Leftover", "n"]];
// filtros da aba History; "disponivel" = sobra de compras já vencidas, fora o produtor bloqueado
const hojeIso = () => new Date().toISOString().slice(0, 10);
const FILTROS_HIST = {
  sobra: (h) => h._sobra >= 0.5,
  disponivel: (h) => h._sobra >= 0.5 && !h._bloqueado && (h.vencimento ?? "") <= hojeIso(),
  inicial: (h) => h._inicial >= 0.5,
};
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

// exportação abastecida por uma compra; `quem` = vínculo feito pela tela
function chipVenda(v, d, quem = null) {
  const dica = [d ? [d.cliente, d.mes ? mesExtenso(d.mes + "-01") : null].filter(Boolean).join(" · ") : "Not found in Digisul", quem].filter(Boolean).join(" — ");
  return `<span class="${quem ? "cert-novo" : ""}" title="${esc(dica)}">${esc(v.venda)} <strong>${fmtN(v.sacas)}</strong></span>`;
}
function origemHist(h) {
  if (h._origem === "digisul") return `<span class="pill" title="Purchase with the certificate in Digisul, due from the start of the control">Digisul</span>`;
  const quem = [h.importado_por, h.alterado_por ? `edited by ${h.alterado_por}` : null, h.obs].filter(Boolean).join(" · ");
  return h._origem === "manual" ? `<span class="pill pill-alerta" title="${esc(quem)}">Manual</span>`
    : `<span class="pill" ${quem ? `title="${esc(quem)}"` : ""}>Spreadsheet${h.alterado_por ? " · edited" : ""}</span>`;
}

// =====================================================================
// PÁGINA
// =====================================================================
// ctx = { api, gerente (pode lançar ajustes), admin, recarregar }
export async function renderCert(link, alvo, ctx) {
  vigiarNegativos(alvo);
  const cert = CERTS[link];
  if (!cert) { alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Unknown certificate page</h3></div>`; return; }
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading certificate…</div>`;
  let base, ajustes, historico, vinculos;
  try {
    [base, ajustes, historico, vinculos] = await Promise.all([ctx.api.certBase(), ctx.api.certAjustes(cert.codigo),
      ctx.api.certHistorico(cert.codigo), ctx.api.certVinculos(cert.codigo)]);
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
  const hist = montarHistorico(historico, vinculos, compras, cert);
  for (const r of vendas) r._vinculado = hist.porVenda.get(r.contrato) ?? 0;
  const inicial = hist.inicial;
  const meses = posicaoMensal(cc, vc, inicial, cert.inicio);
  const atual = hojeYm();
  const ateHoje = meses.filter((l) => l.ym <= atual);
  // saldo hoje: a sobra das compras já vencidas (fora o produtor bloqueado), já sem as
  // sacas vinculadas a exportações; sem histórico, o saldo acumulado até o mês atual
  const saldoHoje = hist.gravadas ? soma(hist.linhas.filter(FILTROS_HIST.disponivel), "_sobra")
    : ateHoje.length ? ateHoje[ateHoje.length - 1].acumulado : inicial;
  const saldoFinal = meses.length ? meses[meses.length - 1].acumulado : inicial;
  const fimHistorico = cert.inicio ? fmtMes(mesAnterior(cert.inicio) + "-01") : null;
  // exportações do Digisul, para mostrar embarque e cliente nos vínculos do histórico
  const vendaPorContrato = new Map(base.vendas.map((r) => [r.contrato, { mes: mesVenda(r), cliente: clienteDoAlerta(r), sacas: r.sacas }]));

  // a aba fica a mesma quando a página recarrega depois de salvar algo
  let aba = abaAberta.get(link) ?? "posicao", busca = buscaAberta.get(link) ?? "", mes = "", fonte = "", ordem = null, filtroHist = "";
  let venceDe = "", venceAte = "";
  const abertos = new Set();
  // produtores fora da soma "Selected": começa sem o produtor bloqueado
  const desmarcados = new Set(hist.produtores.filter((x) => x.bloqueado).map((x) => x.nome));

  const desenhar = () => {
    buscaAberta.set(link, busca);
    const todas = aba === "venda" ? vendas : compras;
    const t = busca.trim().toLowerCase();
    const cols = COLS[aba];
    const abas = `<div class="cert-abas">${segmentos("certAba", [["posicao", "Long / short"], ["compra", `Purchases (${cc.length})`],
      ["venda", `Export sales (${vc.length})`], ["historico", `History (${hist.linhas.length})`], ["produtor", "By producer"]], aba)}</div>`;

    // compra necessária: quanto falta para cobrir as entregas até o mês (o clicado na
    // tabela; sem clique, o primeiro mês daqui em diante que fica short). Compras que
    // vencem antes entram no saldo acumulado e já reduzem a conta.
    const mesNec = mes || meses.find((l) => l.ym >= atual && l.acumulado < 0)?.ym || null;
    const iNec = meses.findIndex((l) => l.ym === mesNec);
    const nec = iNec >= 0 ? Math.max(0, -meses[iNec].acumulado) : 0;
    const necAntes = iNec > 0 ? Math.max(0, -meses[iNec - 1].acumulado) : Math.max(0, -inicial);
    const lMes = meses.find((l) => l.ym === mes);

    const corpoPosicao = () => `
      <div class="pos-kpis">
        ${cert.inicio ? kpi("Opening stock", fmtN(inicial), `end of <span>${esc(fimHistorico)}</span>${cert.bloqueado && hist.excluido ? ` · excl. <span>${esc(cert.bloqueado.nome)}</span>` : ""}`, "", "historico:inicial") : ""}
        ${kpi("Purchased", fmtN(soma(cc, "_sacas")), contratos(cc.length), "", "compra")}
        ${kpi("Sold (export)", fmtN(-soma(vc, "_sacas")), contratos(vc.length), "", "venda")}
        ${kpi("Balance today", fmtN(saldoHoje), hist.gravadas ? "in stock, after the links" : `up to <span>${esc(fmtMes(atual + "-01"))}</span> · ${saldoHoje < 0 ? "short" : "long"}`, "", "historico:disponivel")}
        ${kpi("To buy", nec >= 0.5 ? fmtN(nec) : "–", !mesNec ? "no shortfall ahead"
          : `${nec >= 0.5 ? "to cover up to" : "covered up to"} <span>${esc(fmtMes(mesNec + "-01"))}</span>${nec - necAntes >= 0.5 ? ` · <span>${esc(fmtN(nec - necAntes))}</span> in the month` : ""}`,
          nec >= 0.5 ? "cert-kpi-comprar" : "")}
      </div>

      <div class="pos-card">
        <div class="pos-card-h pos-card-h-linha"><div><h2>Long / short by month</h2>
          <p class="muted">Purchases by due month · export sales by shipment month · running balance. Click a month to see what to buy up to it.</p></div>
          ${lMes ? `<div class="cert-mes-acoes"><strong>${esc(fmtMes(mes + "-01"))}</strong>
            ${lMes.nc ? `<button type="button" class="btn" data-ver-mes="compra" title="Open the purchases of this month">Purchases (${lMes.nc})</button>` : ""}
            ${lMes.nv ? `<button type="button" class="btn" data-ver-mes="venda" title="Open the export sales of this month">Export sales (${lMes.nv})</button>` : ""}
            <button type="button" class="link" id="certLimparMes">${icon("x")}Clear month</button></div>` : ""}</div>
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
      </div>`;

    const corpo = { posicao: corpoPosicao, historico: () => corpoHistorico(t), produtor: corpoProdutor }[aba] ?? (() => corpoContratos(todas, cols, t));
    alvo.innerHTML = `<div class="pos">
      <div class="pos-topo">
        <div class="pos-data">${icon("clock")}<span>${esc(cert.nome)} · Digisul data updated <strong>${esc(tempoRelativo(base.atualizado_em))}</strong></span>
          ${cert.inicio ? `<span class="muted">· contracts starting <span>${esc(fmtMes(cert.inicio + "-01"))}</span></span>` : ""}
          <span class="muted">· all figures in 60 kg bags</span></div>
        <div class="pos-acoes">
          <button class="btn" id="certImagem" title="Download the indicators and the long / short table as an image, in English">${icon("image")}<span>Save image</span></button>
          ${ctx.gerente ? `<button class="btn" id="certSync" title="Fetch Digisul now">${icon("refresh")}<span>Update now</span></button>
          <button class="btn btn-primary" id="certIncluir">${icon("plus")}<span>Include contract</span></button>` : ""}
        </div>
      </div>

      ${orfaos.length ? `<div class="aviso-inline alerta">${icon("alert")}<span>Included or excluded manually but no longer found in Digisul: <strong>${esc(orfaos.map((a) => a.contrato).join(", "))}</strong></span></div>` : ""}
      ${cert.inicio && !hist.gravadas ? `<div class="aviso-inline alerta">${icon("alert")}<span>${historico === null
        ? "The opening stock comes from the history spreadsheet: run section 13 of supabase/schema.sql in the Supabase SQL Editor, then import it in the History tab."
        : "No history imported yet, so the position starts at zero. Import the control spreadsheet in the History tab."}</span></div>` : ""}

      ${abas}
      ${corpo()}
    </div>`;

    ligarSync(alvo, ctx);
    ligarSegmentos(alvo, "certAba", (k) => { aba = k; abaAberta.set(link, k); ordem = null; desenhar(); });
    const fb = $("#certBusca", alvo);
    fb?.addEventListener("input", () => { busca = fb.value; desenhar(); const n = $("#certBusca", alvo); n.focus(); n.setSelectionRange(busca.length, busca.length); });
    $("#certMes", alvo)?.addEventListener("change", (e) => { mes = e.target.value; desenhar(); });
    $("#certFonte", alvo)?.addEventListener("change", (e) => { fonte = e.target.value; desenhar(); });
    $("#certFiltroHist", alvo)?.addEventListener("change", (e) => { filtroHist = e.target.value; desenhar(); });
    // indicadores: abrem embaixo a aba (e o filtro) com os contratos que formam o número
    $$("[data-ir]", alvo).forEach((k) => {
      const ir = () => {
        [aba, filtroHist = ""] = k.dataset.ir.split(":");
        abaAberta.set(link, aba); mes = ""; busca = ""; fonte = ""; ordem = null;
        desenhar();
        $(".cert-abas", alvo)?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      k.addEventListener("click", ir);
      k.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), ir()));
    });
    $("#certLimparMes", alvo)?.addEventListener("click", () => { mes = ""; desenhar(); });
    // mês clicado: o "To buy" passa a ser até ele; os contratos do mês abrem pelos botões
    $$("[data-mes]", alvo).forEach((tr) => tr.addEventListener("click", () => { mes = mes === tr.dataset.mes ? "" : tr.dataset.mes; desenhar(); }));
    $$("[data-ver-mes]", alvo).forEach((b) => b.addEventListener("click", () => {
      aba = b.dataset.verMes; abaAberta.set(link, aba); busca = ""; fonte = ""; ordem = null;
      desenhar();
    }));
    $("#certVenceDe", alvo)?.addEventListener("change", (e) => { venceDe = e.target.value; if (venceAte && venceDe > venceAte) venceAte = venceDe; desenhar(); });
    $("#certVenceAte", alvo)?.addEventListener("change", (e) => { venceAte = e.target.value; if (venceDe && venceAte && venceDe > venceAte) venceDe = venceAte; desenhar(); });
    $("#certLimparVence", alvo)?.addEventListener("click", () => { venceDe = ""; venceAte = ""; desenhar(); });
    $("#certAbrirTodos", alvo)?.addEventListener("click", (e) => {
      const nomes = $$("[data-produtor]", alvo).map((tr) => tr.dataset.produtor);
      if (e.currentTarget.dataset.abrir) nomes.forEach((n) => abertos.add(n)); else abertos.clear();
      desenhar();
    });
    // caixinhas: marcar não abre o produtor
    $$("[data-sel]", alvo).forEach((c) => {
      c.addEventListener("click", (e) => e.stopPropagation());
      c.addEventListener("change", () => { if (c.checked) desmarcados.delete(c.dataset.sel); else desmarcados.add(c.dataset.sel); desenhar(); });
    });
    $("#certSelTodos", alvo)?.addEventListener("change", (e) => {
      const nomes = $$("[data-sel]", alvo).map((c) => c.dataset.sel);
      nomes.forEach((n) => (e.target.checked ? desmarcados.delete(n) : desmarcados.add(n)));
      desenhar();
    });
    $$("[data-produtor]", alvo).forEach((tr) => tr.addEventListener("click", () => {
      const n = tr.dataset.produtor;
      if (!abertos.delete(n)) abertos.add(n);
      desenhar();
    }));
    $$("[data-desvincular]", alvo).forEach((b) => b.addEventListener("click", () => {
      const [venda, chave] = JSON.parse(b.dataset.desvincular);
      desvincular(venda, hist.linhas.find((h) => h._chave === chave), historico, hist, cert, ctx);
    }));
    $$("[data-ordem]", alvo).forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.ordem;
      ordem = ordem?.[0] === k ? (ordem[1] > 0 ? [k, -1] : null) : [k, 1];
      desenhar();
    }));
    $("#certIncluir", alvo)?.addEventListener("click", () => abrirInclusao(compras, vendas, cert, ctx));
    $("#certImportar", alvo)?.addEventListener("click", () => abrirImportacao(cert, ctx, hist.linhas.filter((h) => h._origem === "planilha").length, hist.novos.length));
    $("#certExportar", alvo)?.addEventListener("click", (ev) => exportarExcel(ev.currentTarget, { cert, hist, meses, inicial, fimHistorico, vendaPorContrato }));
    $("#certImagem", alvo)?.addEventListener("click", (ev) => salvarImagem(ev.currentTarget, {
      cert, atualizado: base.atualizado_em, meses, inicial, fimHistorico, atual, saldoFinal, excluido: hist.excluido,
      comprado: soma(cc, "_sacas"), nCompras: cc.length, vendido: soma(vc, "_sacas"), nVendas: vc.length,
      saldoHoje, gravadas: hist.gravadas, nec, necAntes, mesNec,
    }));
    $("#certNovaCompra", alvo)?.addEventListener("click", () => abrirCompra(null, historico, cert, ctx));
    $$("[data-editar-compra]", alvo).forEach((b) => b.addEventListener("click", () => abrirCompra(historico.find((h) => String(h.id) === b.dataset.editarCompra), historico, cert, ctx)));
    $$("[data-remover-compra]", alvo).forEach((b) => b.addEventListener("click", () => removerCompra(hist.linhas.find((h) => String(h.id) === b.dataset.removerCompra), cert, ctx)));
    $$("[data-usar]", alvo).forEach((b) => b.addEventListener("click", () => abrirUso(hist.linhas.find((h) => h._chave === b.dataset.usar), vendas, hist, cert, ctx)));
    $$("[data-vincular]", alvo).forEach((b) => b.addEventListener("click", () => abrirVinculo(vendas.find((r) => r.contrato === b.dataset.vincular), hist, cert, ctx)));
    $$("[data-acao]", alvo).forEach((b) => b.addEventListener("click", () => executarAcao(b.dataset, todas, cert, ctx)));
  };

  // Abas Purchases / Export sales: contratos que contam para o certificado
  const corpoContratos = (todas, cols, t) => {
    let linhas = todas.filter((r) => (fonte === "excluido" ? r._ajuste?.acao === "excluir"
      : r._conta && (!fonte || (fonte === "manual" ? !!r._ajuste : !r._ajuste))))
      .filter((r) => (!mes || r._mes === mes)
        && (!t || [r.contrato, r.fornecedor, r.importador, r.alertas, r.padrao, r.certificado, r.safra].some((x) => String(x ?? "").toLowerCase().includes(t))));
    linhas = ordenar(linhas, ordem, (a, b) => String(a._mes ?? "").localeCompare(String(b._mes ?? "")) || a.contrato.localeCompare(b.contrato, "en", { numeric: true }));
    const nExcl = todas.filter((r) => r._ajuste?.acao === "excluir").length;
    return `<div class="pos-filtros">
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
          ${ctx.gerente ? `<td class="cert-acoes">${aba === "venda" && r._conta && vinculos !== null ? `<button type="button" class="link" data-vincular="${esc(r.contrato)}" title="Which BRC purchases this export came from">${icon("link")}Link</button>` : ""}${acao(r)}</td>` : ""}</tr>`).join("")
          : `<tr><td colspan="${cols.length + 1 + (ctx.gerente ? 1 : 0)}" class="vazio-td">No contracts match these filters.</td></tr>`}</tbody>
      </table></div>`;
  };

  // Aba History: a planilha de controle, compra BRC por compra BRC, com as
  // exportações que ela abasteceu e a sobra
  const corpoHistorico = (t) => {
    let linhas = hist.linhas.filter((h) => FILTROS_HIST[filtroHist]?.(h) ?? true).filter((h) => !t || [h.compra, h.id_cert, h.fornecedor, h.fazenda, ...h.vinculos.map((v) => v.venda), ...h._novos.map((v) => v.venda)]
      .some((x) => String(x ?? "").toLowerCase().includes(t)));
    // planilha na ordem dela, depois as incluídas pela tela e as do Digisul pelo vencimento
    const peso = { planilha: 0, manual: 1, digisul: 2 };
    linhas = ordenar(linhas, ordem, (a, b) => peso[a._origem] - peso[b._origem] || (a.ordem ?? 0) - (b.ordem ?? 0)
      || String(a.vencimento ?? "").localeCompare(String(b.vencimento ?? "")));
    const importado = historico?.find((h) => (h.origem ?? "planilha") === "planilha");
    const editar = ctx.gerente && vinculos !== null;
    // busca por exportação (BRAS): em cima, de quais compras BRC ela saiu; na tabela,
    // só os vínculos com ela
    const doVinculo = (v) => !!t && String(v.venda ?? "").toLowerCase().includes(t);
    const usos = new Map();
    for (const h of hist.linhas) {
      for (const v of [...h.vinculos, ...h._novos]) if (doVinculo(v)) {
        if (!usos.has(v.venda)) usos.set(v.venda, []);
        usos.get(v.venda).push({ h, sacas: v.sacas, quem: h._novos.includes(v) ? quemLancou(v) : null });
      }
    }
    const porExportacao = [...usos].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
    const quadroExportacao = !porExportacao.length ? "" : `<div class="pos-card">
        <div class="pos-card-h"><h2>BRC purchases used by the export</h2></div>
        <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num">
          <thead><tr><th>BRC contract</th><th>CP ID</th><th>Producer</th><th>Farm</th><th>Due date</th><th class="num">Bags used</th>${editar ? "<th></th>" : ""}</tr></thead>
          <tbody>${porExportacao.map(([venda, us]) => {
            const d = vendaPorContrato.get(venda);
            const ligadas = soma(us, "sacas");
            return `<tr class="cert-grupo"><td colspan="5"><strong>${esc(venda)}</strong>
                <span class="muted">${esc([d?.cliente, d?.mes ? mesExtenso(d.mes + "-01") : null, d?.sacas != null ? `${fmtN(d.sacas)} bags` : d ? null : "Not found in Digisul"].filter(Boolean).join(" · "))}</span></td>
                ${num(ligadas, true)}${editar ? "<td></td>" : ""}</tr>
              ${us.map(({ h, sacas, quem }) => `<tr ${quem ? `title="${esc(`Linked in the portal · ${quem}`)}"` : ""}><td>${esc(h.compra)}</td><td>${esc(h.id_cert ?? "—")}</td>
                <td>${esc(h.fornecedor ?? "—")}</td><td>${esc(h.fazenda ?? "—")}</td><td>${esc(h.vencimento ? fmtData(h.vencimento.slice(0, 10)) : "—")}</td>${num(sacas)}
                ${editar ? `<td class="cert-acoes"><button type="button" class="link" data-desvincular="${esc(JSON.stringify([venda, h._chave]))}" title="Remove this link: the bags go back to the leftover of the purchase">${icon("x")}Unlink</button></td>` : ""}</tr>`).join("")}`;
          }).join("")}</tbody>
        </table></div>
      </div>`;
    return `<div class="pos-filtros">
        <label class="busca sm">${icon("search")}<input type="search" id="certBusca" placeholder="Search contract, producer, export…" value="${esc(busca)}"></label>
        <select id="certFiltroHist" aria-label="Filter"><option value="">All contracts</option>
          <option value="sobra" ${filtroHist === "sobra" ? "selected" : ""}>With leftover</option>
          <option value="disponivel" ${filtroHist === "disponivel" ? "selected" : ""}>Available today</option>
          ${cert.inicio ? `<option value="inicial" ${filtroHist === "inicial" ? "selected" : ""}>In the opening stock</option>` : ""}</select>
        ${editar ? `<button class="btn" id="certNovaCompra">${icon("plus")}<span>Add purchase</span></button>` : ""}
        ${hist.linhas.length ? `<button class="btn" id="certExportar" title="Download the history, links, producers and monthly position">${icon("download")}<span>Export to Excel</span></button>` : ""}
        ${ctx.gerente ? `<button class="btn" id="certImportar">${icon("upload")}<span>Import spreadsheet</span></button>` : ""}
      </div>
      ${ctx.gerente && historico !== null && vinculos === null ? `<div class="aviso-inline alerta">${icon("alert")}<span>To edit the history and link shipments here, run section 14 of supabase/schema.sql in the Supabase SQL Editor.</span></div>` : ""}
      ${!hist.linhas.length ? `<div class="vazio">${icon("file")}<h3>No history imported</h3>
        <p>Import the Controle CAFE Pratices spreadsheet (CONTROLE sheet): each BRC purchase, the exports it went to and the leftover.</p></div>` : `
      ${porExportacao.length ? quadroExportacao : `
      ${importado ? `<p class="muted pos-nota">${esc(["Spreadsheet imported", importado.importado_por, fmtData(importado.created_at.slice(0, 10))].filter(Boolean).join(" · "))}</p>` : ""}
      <p class="muted pos-nota">The leftover of the purchases due before the control starts is the opening stock; later purchases come from Digisul in their due month.</p>
      <p class="muted pos-nota">Search an export (BRAS) to see which BRC purchases it came from. To link one, use “Link” on the export in the Export sales tab.</p>`}
      <div class="pos-resumo">
        <span><strong>${fmtN(linhas.length)}</strong> ${linhas.length === 1 ? "contract" : "contracts"}</span>
        <span><strong>${fmtN(soma(linhas, "sacas"))}</strong> bags</span>
        <span><strong>${fmtN(soma(linhas, "_usado"))}</strong> used</span>
        <span><strong>${fmtN(soma(linhas, "_sobra"))}</strong> leftover</span>
      </div>
      <div class="tabela-wrap pos-tabela pos-contratos"><table class="tabela tabela-num">
        <thead><tr>${cabecalho(COLS_HIST, ordem)}<th>Exports</th><th>Source</th>${editar ? "<th></th>" : ""}</tr></thead>
        <tbody>${linhas.length ? linhas.map((h) => `<tr class="${h._bloqueado ? "cert-bloqueado" : ""}">${COLS_HIST.map(([k, , tipo]) => celula(h, k, tipo)).join("")}
          <td class="cert-vinculos"><div>${h.vinculos.length || h._novos.length ? [
            ...h.vinculos.filter((v) => !porExportacao.length || doVinculo(v)).map((v) => chipVenda(v, vendaPorContrato.get(v.venda))),
            ...h._novos.filter((v) => !porExportacao.length || doVinculo(v)).map((v) => chipVenda(v, vendaPorContrato.get(v.venda), quemLancou(v))),
          ].join("") || `<span class="muted">—</span>` : `<span class="muted">—</span>`}</div></td>
          <td>${origemHist(h)}</td>
          ${editar ? `<td class="cert-acoes">${h._sobra >= 0.5 ? `<button type="button" class="link" data-usar="${esc(h._chave)}" title="Use bags of this leftover in an export">${icon("link")}Use</button>` : ""}${h._origem === "digisul" ? "" : `<button type="button" class="link" data-editar-compra="${h.id}">${icon("edit")}Edit</button>
            ${h._origem === "manual" ? `<button type="button" class="link" data-remover-compra="${h.id}">${icon("trash")}Remove</button>` : ""}`}</td>` : ""}</tr>`).join("")
          : `<tr><td colspan="${COLS_HIST.length + 2 + (editar ? 1 : 0)}" class="vazio-td">No contracts match the search.</td></tr>`}</tbody>
      </table></div>`}`;
  };

  // Aba By producer: as compras BRC do histórico somadas por produtor, no período de
  // vencimento escolhido (vencimento = pagamento do café); o "+" abre as compras dele
  const corpoProdutor = () => {
    if (!hist.linhas.length) return `<div class="vazio">${icon("file")}<h3>No history imported</h3><p>Import the control spreadsheet in the History tab.</p></div>`;
    const ym = (h) => (h.vencimento ?? "").slice(0, 7);
    const mesesVenc = [...new Set(hist.linhas.map(ym).filter(Boolean))].sort();
    const noPeriodo = hist.linhas.filter((h) => (!venceDe || ym(h) >= venceDe) && (!venceAte || (ym(h) && ym(h) <= venceAte)));
    const grupos = new Map();
    for (const h of noPeriodo) (grupos.get(h._produtor) ?? grupos.set(h._produtor, []).get(h._produtor)).push(h);
    const p = [...grupos].map(([nome, hs]) => ({ nome, hs: hs.sort((a, b) => ym(a).localeCompare(ym(b)) || a.compra.localeCompare(b.compra, "en", { numeric: true })),
      sacas: hs.reduce((s, h) => s + (Number(h.sacas) || 0), 0), usado: soma(hs, "_usado"), sobra: soma(hs, "_sobra"), bloqueado: hs.some((h) => h._bloqueado) }))
      .sort((a, b) => b.sobra - a.sobra || a.nome.localeCompare(b.nome));
    const opcoes = (atual) => mesesVenc.map((m) => `<option value="${m}" ${m === atual ? "selected" : ""}>${esc(fmtMes(m + "-01"))}</option>`).join("");
    const todosAbertos = p.length && p.every((x) => abertos.has(x.nome));
    const sel = p.filter((x) => !desmarcados.has(x.nome));
    const todosMarcados = sel.length === p.length;
    return `<div class="pos-filtros">
        <label class="cert-periodo"><span>Due from</span><select id="certVenceDe" aria-label="Due from"><option value="">First</option>${opcoes(venceDe)}</select></label>
        <label class="cert-periodo"><span>to</span><select id="certVenceAte" aria-label="Due to"><option value="">Last</option>${opcoes(venceAte)}</select></label>
        ${venceDe || venceAte ? `<button type="button" class="link" id="certLimparVence">${icon("x")}All due dates</button>` : ""}
        ${p.length ? `<button type="button" class="btn" id="certAbrirTodos" data-abrir="${todosAbertos ? "" : "1"}">${todosAbertos ? "Collapse all" : "Expand all"}</button>` : ""}
      </div>
      <div class="pos-card">
        <div class="pos-card-h"><h2>By producer</h2><p class="muted">Due date = coffee payment date. Click a producer to see its BRC purchases; tick the ones to add up in “Selected”.</p></div>
        <div class="tabela-wrap pos-tabela"><table class="tabela tabela-num cert-produtores">
          <thead><tr><th class="cert-sel"><input type="checkbox" id="certSelTodos" aria-label="Select all" ${todosMarcados ? "checked" : ""}></th>
            <th>Producer</th><th>Due date</th><th class="num">Contracts</th><th class="num">Bags</th><th class="num">Used in exports</th><th class="num">Leftover</th></tr></thead>
          <tbody>${p.length ? p.map((x) => {
            const aberto = abertos.has(x.nome), marcado = !desmarcados.has(x.nome);
            return `<tr class="clicavel cert-prod ${marcado ? "" : "cert-fora"}" data-produtor="${esc(x.nome)}" aria-expanded="${aberto}">
                <td class="cert-sel"><input type="checkbox" data-sel="${esc(x.nome)}" aria-label="${esc(x.nome)}" ${marcado ? "checked" : ""}></td>
                <td><span class="cert-mais">${aberto ? "−" : "+"}</span>${esc(x.nome)}${x.bloqueado ? ` <span class="pill pill-critico" title="Over the volume we can use: the leftover is not counted">Over limit</span>` : ""}</td>
                <td></td><td class="num">${fmtN(x.hs.length)}</td>${num(x.sacas)}${num(x.usado)}${num(x.sobra, true)}</tr>
              ${aberto ? x.hs.map((h) => `<tr class="cert-brc ${h._bloqueado ? "cert-bloqueado" : ""} ${marcado ? "" : "cert-fora"}"><td></td>
                <td>${esc(h.compra)}${h.id_cert ? ` <span class="muted">· ${esc(h.id_cert)}</span>` : ""}${h.fazenda ? ` <span class="muted">· ${esc(h.fazenda)}</span>` : ""}</td>
                <td>${esc(h.vencimento ? fmtData(h.vencimento.slice(0, 10)) : "—")}</td><td></td>${num(Number(h.sacas) || 0)}${num(h._usado)}${num(h._sobra)}</tr>`).join("") : ""}`;
          }).join("") : `<tr><td colspan="7" class="vazio-td">No purchases due in this period.</td></tr>`}</tbody>
          ${p.length ? `<tfoot>
            <tr class="cert-selecionados"><td></td><td>Selected <span class="muted">(${sel.length} of ${p.length})</span></td><td></td><td class="num">${fmtN(sel.reduce((s, x) => s + x.hs.length, 0))}</td>${num(soma(sel, "sacas"))}${num(soma(sel, "usado"))}${num(soma(sel, "sobra"), true)}</tr>
            ${todosMarcados ? "" : `<tr><td></td><td>Total</td><td></td><td class="num">${fmtN(noPeriodo.length)}</td>${num(soma(p, "sacas"))}${num(soma(p, "usado"))}${num(soma(p, "sobra"), true)}</tr>`}</tfoot>` : ""}
        </table></div>
      </div>`;
  };
  desenhar();
}

// `sub` é HTML (o mês fica num elemento à parte, para a tradução da tela)
// `ir` = aba (e filtro) que o clique no indicador abre embaixo
const kpi = (titulo, valor, sub, cls = "", ir = "") => `<div class="pos-kpi pos-kpi-est ${cls} ${ir ? "cert-kpi-link" : ""}" ${ir ? `data-ir="${ir}" role="button" tabindex="0"` : ""}>
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

function abrirImportacao(cert, ctx, atuais, nVinculos = 0) {
  modal({
    titulo: `Import ${cert.codigo} history`,
    botao: "Read and import",
    corpo: `<p class="muted">Choose the Controle CAFE Pratices spreadsheet (.xlsx). The CONTROLE sheet is read in your browser:
      each BRC purchase, the exports it went to and the leftover.</p>
      ${atuais ? `<p class="muted">It replaces the ${fmtN(atuais)} contracts imported before. Purchases added on the portal stay.</p>` : ""}
      ${nVinculos ? `<div class="aviso-inline alerta">${icon("alert")}<span>Shipment links made on the portal to spreadsheet contracts are removed with them. You only need to import once: after that, edit the history here.</span></div>` : ""}
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

// Inclui ou edita uma compra do histórico (contrato BRC que não veio da planilha, ou correção)
function abrirCompra(h, historico, cert, ctx) {
  const v = (k) => esc(h?.[k] ?? "");
  modal({
    titulo: h ? "Edit purchase" : "Add purchase",
    botao: "Save",
    corpo: `<p class="muted">${h ? "Changes are recorded with your name." : `A BRC purchase with the ${esc(cert.nome)} certificate that is not in the history. Purchases due from the start of the control already come from Digisul.`}</p>
      <div class="cert-form">
        <label class="campo"><span>BRC contract *</span><input type="text" name="compra" required maxlength="40" value="${v("compra")}" placeholder="BRC-0000/26"></label>
        <label class="campo"><span>CP ID</span><input type="text" name="id_cert" maxlength="40" value="${v("id_cert")}"></label>
        <label class="campo"><span>Producer *</span><input type="text" name="fornecedor" required maxlength="120" value="${v("fornecedor")}"></label>
        <label class="campo"><span>Farm</span><input type="text" name="fazenda" maxlength="120" value="${v("fazenda")}"></label>
        <label class="campo"><span>Bags *</span><input type="number" name="sacas" min="0" step="0.01" required value="${v("sacas")}"></label>
        <label class="campo"><span>Used before the portal</span><input type="number" name="usado" min="0" step="0.01" value="${h ? v("usado") : "0"}"></label>
        <label class="campo"><span>Due date *</span><input type="date" name="vencimento" required value="${v("vencimento")}"></label>
        <label class="campo"><span>Note</span><input type="text" name="obs" maxlength="200" value="${v("obs")}"></label>
      </div>`,
    async onSubmit(f) {
      const compra = f.compra.value.trim().toUpperCase(), fornecedor = f.fornecedor.value.trim();
      const sacas = Number(f.sacas.value), usado = f.usado.value === "" ? 0 : Number(f.usado.value);
      if (!compra || !fornecedor || !f.vencimento.value) throw new Error("Fill in the contract, producer and due date.");
      if (!(sacas > 0)) throw new Error("Bags must be greater than zero.");
      if (usado < 0 || usado > sacas) throw new Error("Used must be between zero and the contract bags.");
      const ordem = h?.ordem ?? Math.max(0, ...(historico ?? []).map((x) => x.ordem ?? 0)) + 1;
      await ctx.api.salvarCertCompra({ id: h?.id, certificado: cert.codigo, ordem, compra, id_cert: f.id_cert.value.trim() || null, fornecedor,
        fazenda: f.fazenda.value.trim() || null, sacas, usado, vencimento: f.vencimento.value, obs: f.obs.value.trim() || null });
      toast(h ? "Purchase updated." : "Purchase added to the history.");
      ctx.recarregar();
    },
  });
}

async function removerCompra(h, cert, ctx) {
  if (!h) return;
  const ok = await confirmar("Remove purchase", `<strong>${esc(h.compra)}</strong><br>Remove this purchase from the ${esc(cert.codigo)} history?${h._novos.length ? " Its shipment links are removed too." : ""}`, "Remove");
  if (!ok) return;
  try {
    await ctx.api.removerCertCompra(h.id);
    toast("Purchase removed from the history.");
    ctx.recarregar();
  } catch (e) { toast(e.message, "erro"); }
}

// Desfaz o vínculo de uma exportação com uma compra BRC: as sacas voltam para a sobra.
// O vínculo da planilha sai da linha do histórico (e do "usado"); o feito pela tela,
// de bi_cert_vinculos (os outros vínculos do embarque continuam)
async function desvincular(venda, h, historico, hist, cert, ctx) {
  if (!h) return;
  const daPlanilha = h.vinculos.filter((v) => v.venda === venda);
  const daTela = h._novos.filter((v) => v.venda === venda);
  const tirar = daPlanilha.reduce((s, v) => s + (Number(v.sacas) || 0), 0);
  const sacas = tirar + soma(daTela, "sacas");
  const ok = await confirmar("Unlink export", `<strong>${esc(venda)}</strong> · <strong>${esc(h.compra)}</strong> · ${esc(fmtN(sacas))} bags<br>
    Remove this link? The bags go back to the leftover of the purchase.`, "Unlink");
  if (!ok) return;
  try {
    if (daTela.length) {
      const chave = (v) => (v.historico_id != null ? `h:${v.historico_id}` : `d:${v.compra}`);
      await ctx.api.salvarCertVinculos(cert.codigo, venda, hist.novos.filter((v) => v.venda === venda && chave(v) !== h._chave)
        .map((v) => ({ historico_id: v.historico_id, compra: v.compra, sacas: v.sacas })));
    }
    if (daPlanilha.length) {
      const linha = historico.find((x) => x.id === h.id);
      await ctx.api.desvincularCertHistorico(h.id, {
        vinculos: (linha.vinculos ?? []).filter((v) => v.venda !== venda),
        usado: Math.max(0, (Number(linha.usado) || 0) - tirar),
        obs: [linha.obs, `unlinked ${venda} (${tirar})`].filter(Boolean).join(" · "),
      });
    }
    toast("Link removed: the bags are back in the leftover.");
    ctx.recarregar();
  } catch (e) { toast(e.message, "erro"); }
}

// Vincula uma exportação às compras BRC de onde saem as sacas (troca os vínculos dela)
function abrirVinculo(r, hist, cert, ctx) {
  if (!r) return;
  const meus = new Map(hist.novos.filter((v) => v.venda === r.contrato).map((v) => [v.historico_id != null ? `h:${v.historico_id}` : `d:${v.compra}`, v.sacas]));
  const daPlanilha = hist.linhas.flatMap((h) => h.vinculos.filter((v) => v.venda === r.contrato).map((v) => ({ compra: h.compra, sacas: Number(v.sacas) || 0 })));
  // origens: compras com sobra (ou já vinculadas a este embarque); bloqueadas no fim
  const fontes = hist.linhas.map((h) => ({ ...h, _disp: h._sobra + (meus.get(h._chave) ?? 0) }))
    .filter((h) => h._disp > 0.5 || meus.has(h._chave))
    .sort((a, b) => a._bloqueado - b._bloqueado || b._vencida - a._vencida || String(a.vencimento ?? "").localeCompare(String(b.vencimento ?? "")));
  const alvoSacas = r._sacas ?? 0;
  const totalPlanilha = soma(daPlanilha, "sacas");
  modal({
    titulo: "Link shipment to BRC purchases",
    botao: "Save links",
    largura: "modal-lg cert-modal-largo",
    corpo: `<p><strong>${esc(r.contrato)}</strong> <span class="muted">${esc(["", r._cliente, r.embarque ? mesExtenso(r.embarque) : null, `${fmtN(alvoSacas)} bags`].filter((x) => x != null).join(" · "))}</span></p>
      <p class="muted">Type how many bags of this export come from each BRC purchase. The leftover of each purchase updates when you save.</p>
      ${daPlanilha.length ? `<p class="muted pos-nota">${esc(["Already in the spreadsheet", ...daPlanilha.map((v) => `${v.compra} ${fmtN(v.sacas)}`)].join(" · "))}</p>` : ""}
      <label class="busca">${icon("search")}<input type="search" id="vinBusca" placeholder="Search contract or producer…" autocomplete="off"></label>
      <div class="tabela-wrap pos-tabela cert-lista cert-lista-alta"><table class="tabela tabela-num">
        <thead><tr><th>BRC contract</th><th>Producer</th><th>Due date</th><th class="num">Available</th><th class="num">Bags from it</th></tr></thead>
        <tbody>${fontes.length ? fontes.map((h) => `<tr data-fonte="${esc(`${h.compra} ${h.fornecedor ?? ""}`.toLowerCase())}" class="${h._bloqueado ? "cert-bloqueado" : ""}">
          <td>${esc(h.compra)}${h._origem === "digisul" ? ` <span class="pill">Digisul</span>` : ""}</td>
          <td>${esc(h.fornecedor ?? "—")}${h._bloqueado ? ` <span class="pill pill-critico">Over limit</span>` : ""}</td>
          <td>${esc(fmtData(h.vencimento))}</td><td class="num">${fmtN(h._disp)}</td>
          <td class="num"><input type="number" class="cert-qtd" min="0" step="0.01" data-chave="${esc(h._chave)}" value="${meus.has(h._chave) ? meus.get(h._chave) : ""}" aria-label="${esc(h.compra)}"></td></tr>`).join("")
          : `<tr><td colspan="5" class="vazio-td">No purchase with leftover in the history.</td></tr>`}</tbody>
      </table></div>
      <p class="pos-nota" id="vinTotal"></p>`,
    onOpen(form) {
      const total = () => {
        const t = $$(".cert-qtd", form).reduce((s, i) => s + (Number(i.value) || 0), 0) + totalPlanilha;
        const falta = alvoSacas - t;
        $("#vinTotal", form).innerHTML = `<span>Linked</span> <strong>${esc(fmtN(t))}</strong> <span>of</span> <strong>${esc(fmtN(alvoSacas))}</strong> <span>bags</span>`
          + (falta >= 0.5 ? ` · <span>Missing</span> <strong class="cert-falta">${esc(fmtN(falta))}</strong>` : falta > -0.5 ? ` · <span class="pill pill-ok">Complete</span>` : ` <span class="pill pill-critico">More than the export</span>`);
      };
      $$(".cert-qtd", form).forEach((i) => i.addEventListener("input", total));
      $("#vinBusca", form).addEventListener("input", (e) => {
        const q = e.target.value.trim().toLowerCase();
        $$("[data-fonte]", form).forEach((tr) => { tr.hidden = !!q && !tr.dataset.fonte.includes(q); });
      });
      total();
    },
    async onSubmit(form) {
      const linhas = [];
      for (const i of $$(".cert-qtd", form)) {
        const sacas = Number(i.value) || 0;
        if (sacas < 0) throw new Error("Bags cannot be negative.");
        if (!sacas) continue;
        const h = fontes.find((x) => x._chave === i.dataset.chave);
        if (sacas > h._disp + 0.5) throw new Error(`${h.compra} has only ${fmtN(h._disp)} bags available.`);
        linhas.push({ historico_id: h._origem === "digisul" ? null : h.id, compra: h.compra, sacas });
      }
      if (soma(linhas, "sacas") + totalPlanilha > alvoSacas + 0.5) throw new Error(`The links add up to more than the ${fmtN(alvoSacas)} bags of the export.`);
      await ctx.api.salvarCertVinculos(cert.codigo, r.contrato, linhas);
      toast(linhas.length ? "Shipment links saved." : "Shipment links removed.");
      ctx.recarregar();
    },
  });
}

// Usa sacas da sobra de uma compra numa exportação (o mesmo vínculo do "Link", visto
// pelo lado da compra). Exportação que ainda não conta para o certificado passa a
// contar com as sacas vinculadas (inclusão manual).
function abrirUso(h, vendas, hist, cert, ctx) {
  if (!h) return;
  // incluída à mão com parte das sacas: o teto é o contrato inteiro (a inclusão acompanha os vínculos)
  const parcial = (r) => r._ajuste?.acao === "incluir" && r._ajuste.sacas != null;
  const teto = (r) => (r._conta && !parcial(r) ? r._sacas ?? 0 : Number(r.sacas) || 0);
  const faltam = (r) => teto(r) - (r._vinculado ?? 0);
  const desta = (r) => hist.novos.find((v) => v.venda === r.contrato && (v.historico_id != null ? `h:${v.historico_id}` : `d:${v.compra}`) === h._chave)?.sacas ?? 0;
  const opcoes = vendas.filter((r) => faltam(r) >= 0.5 || desta(r) > 0)
    .sort((a, b) => b._conta - a._conta || String(a._mes ?? "").localeCompare(String(b._mes ?? "")) || a.contrato.localeCompare(b.contrato, "en", { numeric: true }));
  let escolhida = null;
  const lista = (q) => {
    const achadas = opcoes.filter((r) => !q || [r.contrato, r._cliente, r.importador, r.alertas].some((x) => String(x ?? "").toLowerCase().includes(q))).slice(0, 60);
    if (!achadas.length) return `<p class="muted pos-nota">No export with bags still without a BRC purchase.</p>`;
    return `<div class="tabela-wrap pos-tabela cert-lista"><table class="tabela tabela-num">
      <thead><tr><th></th><th>Contract</th><th>Client (alert)</th><th>Shipment</th><th class="num">Bags</th><th class="num">Without BRC</th><th></th></tr></thead>
      <tbody>${achadas.map((r) => `<tr class="clicavel" data-escolher="${esc(r.contrato)}">
        <td><input type="radio" name="venda" value="${esc(r.contrato)}" ${escolhida === r.contrato ? "checked" : ""} aria-label="${esc(r.contrato)}"></td>
        <td>${esc(r.contrato)}</td><td>${esc(r._cliente ?? "—")}</td><td>${esc(r._mes ? mesExtenso(r._mes + "-01") : "—")}</td>
        <td class="num">${fmtN(teto(r))}</td><td class="num">${fmtN(faltam(r) + desta(r))}</td>
        <td>${r._conta ? "" : `<span class="pill pill-alerta" title="Not in the position yet: it is included with the bags you link">Not in ${esc(cert.codigo)}</span>`}</td></tr>`).join("")}</tbody></table></div>`;
  };
  modal({
    titulo: "Use leftover in an export",
    botao: "Link",
    largura: "modal-lg",
    corpo: `<p><strong>${esc(h.compra)}</strong> <span class="muted">${esc(["", h.fornecedor, `${fmtN(h._sobra)} bags left`].filter((x) => x != null).join(" · "))}</span></p>
      <p class="muted">Choose the export these bags go to. An export that is not in the ${esc(cert.codigo)} position yet is included with the bags you link.</p>
      <label class="busca">${icon("search")}<input type="search" id="usoBusca" placeholder="Search contract, supplier, client…" autocomplete="off"></label>
      <div id="usoLista">${lista("")}</div>
      <div class="cert-inc-campos">
        <label class="campo"><span>Bags *</span><input type="number" name="sacas" min="0" step="0.01" required></label>
      </div>`,
    onOpen(form) {
      const box = $("#usoLista", form);
      const ligar = () => $$("[data-escolher]", box).forEach((tr) => tr.addEventListener("click", () => {
        escolhida = tr.dataset.escolher;
        $$("input[name=venda]", box).forEach((i) => { i.checked = i.value === escolhida; });
        const r = opcoes.find((x) => x.contrato === escolhida);
        form.sacas.value = Math.round(Math.min(h._sobra + desta(r), faltam(r) + desta(r)) * 100) / 100;
      }));
      $("#usoBusca", form).addEventListener("input", (e) => { box.innerHTML = lista(e.target.value.trim().toLowerCase()); ligar(); });
      ligar();
    },
    async onSubmit(form) {
      const r = opcoes.find((x) => x.contrato === escolhida);
      if (!r) throw new Error("Choose an export from the list.");
      const sacas = Number(form.sacas.value) || 0;
      if (!(sacas > 0)) throw new Error("Bags must be greater than zero.");
      if (sacas > h._sobra + desta(r) + 0.5) throw new Error(`Only ${fmtN(h._sobra + desta(r))} bags left in this purchase.`);
      if (sacas > faltam(r) + desta(r) + 0.5) throw new Error(`This export has only ${fmtN(faltam(r) + desta(r))} bags without a BRC purchase.`);
      // os outros vínculos do embarque continuam; o desta compra passa a ser `sacas`
      const linhas = hist.novos.filter((v) => v.venda === r.contrato && (v.historico_id != null ? `h:${v.historico_id}` : `d:${v.compra}`) !== h._chave)
        .map((v) => ({ historico_id: v.historico_id, compra: v.compra, sacas: v.sacas }))
        .concat({ historico_id: h._origem === "digisul" ? null : h.id, compra: h.compra, sacas });
      await ctx.api.salvarCertVinculos(cert.codigo, r.contrato, linhas);
      if (!r._conta || parcial(r)) {
        await ctx.api.salvarCertAjuste({ certificado: cert.codigo, tipo: "venda", contrato: r.contrato, acao: "incluir",
          sacas: soma(linhas, "sacas") + (hist.porVenda.get(r.contrato) ?? 0) - soma(hist.novos.filter((v) => v.venda === r.contrato), "sacas"),
          obs: `${cert.codigo} bags from ${linhas.map((l) => l.compra).join(", ")}` });
      }
      toast(r._conta ? "Shipment links saved." : `Shipment links saved and export included in ${cert.codigo}.`);
      ctx.recarregar();
    },
  });
}

// Baixa o histórico em Excel (cópia de segurança e para quem não usa o portal):
// compras com a sobra, um vínculo por linha, resumo por produtor e a posição por mês
async function exportarExcel(botao, { cert, hist, meses, inicial, fimHistorico, vendaPorContrato }) {
  botao.disabled = true;
  try {
    const XLSX = await carregarXlsx();
    const T = (s) => traduzir(s);
    const data = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`) : null);
    const n = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const origem = (h) => T(h._origem === "digisul" ? "Digisul" : h._origem === "manual" ? "Manual" : "Spreadsheet");
    const aba = (cab, linhas, larguras) => {
      const ws = XLSX.utils.aoa_to_sheet([cab.map(T), ...linhas], { cellDates: true, dateNF: "dd/mm/yyyy" });
      ws["!cols"] = larguras.map((wch) => ({ wch }));
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: linhas.length, c: cab.length - 1 } }) };
      return ws;
    };
    const linhas = [...hist.linhas].sort((a, b) => (a.ordem ?? 1e9) - (b.ordem ?? 1e9) || String(a.vencimento ?? "").localeCompare(String(b.vencimento ?? "")));

    const compras = aba(["BRC contract", "CP ID", "Producer", "Farm", "Due date", "Bags", "Used", "Leftover", "Status", "Over limit", "Source", "Note", "Exports"],
      linhas.map((h) => [h.compra, h.id_cert ?? "", h.fornecedor ?? "", h.fazenda ?? "", data(h.vencimento), n(h.sacas), n(h._usado), n(h._sobra),
        T(h._vencida ? "Due" : "Not due yet"), h._bloqueado ? T("Yes") : "", origem(h), h.obs ?? "",
        [...h.vinculos, ...h._novos].map((v) => `${v.venda} (${fmtN(v.sacas)})`).join(", ")]),
      [18, 12, 34, 18, 12, 10, 10, 10, 12, 10, 12, 24, 60]);

    const vinculos = aba(["BRC contract", "Producer", "Export", "Client (alert)", "Shipment", "Bags", "Source", "Linked by", "Date"],
      linhas.flatMap((h) => [
        ...h.vinculos.map((v) => ({ v, quem: null })),
        ...h._novos.map((v) => ({ v, quem: v })),
      ].map(({ v, quem }) => {
        const d = vendaPorContrato.get(v.venda);
        return [h.compra, h.fornecedor ?? "", v.venda, d?.cliente ?? "", d?.mes ? data(`${d.mes}-01`) : null, n(v.sacas),
          T(quem ? "Portal" : "Spreadsheet"), quem?.autor ?? "", quem?.created_at ? data(quem.created_at) : null];
      })),
      [18, 34, 18, 30, 12, 10, 12, 22, 12]);
    // embarque é mês: mostra "nov/2026"
    for (const [ref, c] of Object.entries(vinculos)) if (/^E\d+$/.test(ref) && ref !== "E1" && c.v != null) c.z = "mmm/yyyy";

    const p = hist.produtores;
    const produtores = aba(["Producer", "Contracts", "Bags", "Used", "Leftover due", "Not due yet", "Opening stock", "Over limit"],
      [...p.map((x) => [x.nome, x.n, n(x.sacas), n(x.usado), n(x.estoque), n(x.futuro), n(x.inicial), x.bloqueado ? T("Yes") : ""]),
        [T("Total"), p.reduce((s, x) => s + x.n, 0), n(soma(p, "sacas")), n(soma(p, "usado")), n(soma(p, "estoque")), n(soma(p, "futuro")), n(inicial), ""]],
      [40, 10, 12, 12, 14, 12, 14, 10]);

    const posicao = aba(["Month", "Purchases", "Sales", "Net", "Running balance"],
      [...(inicial ? [[`${T("Opening stock")} (${fimHistorico ?? ""})`, null, null, null, n(inicial)]] : []),
        ...meses.map((l) => [fmtMes(`${l.ym}-01`), n(l.compras), n(-l.vendas), n(l.saldo), n(l.acumulado)])],
      [24, 12, 12, 12, 16]);
    for (const ws of [compras, vinculos, produtores, posicao]) {
      for (const [ref, c] of Object.entries(ws)) if (ref[0] !== "!" && c.t === "n" && !/^[A-Z]+1$/.test(ref)) c.z ??= "#,##0;(#,##0)";
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, compras, T("History").slice(0, 31));
    XLSX.utils.book_append_sheet(wb, vinculos, T("Links").slice(0, 31));
    XLSX.utils.book_append_sheet(wb, produtores, T("By producer").slice(0, 31));
    XLSX.utils.book_append_sheet(wb, posicao, T("Position").slice(0, 31));
    XLSX.writeFile(wb, `${cert.codigo} ${T("History")} ${hojeIso()}.xlsx`);
  } catch (e) {
    toast(e.message, "erro");
  } finally {
    botao.disabled = false;
  }
}

// Imagem para mandar a posição (como no informativo diário): indicadores e a tabela
// long / short completa, sempre em inglês e no tema claro, qualquer que seja a tela
const HTML2CANVAS_URL = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
let html2canvasPromise = null;
function carregarHtml2canvas() {
  html2canvasPromise ??= new Promise((ok, falha) => {
    if (window.html2canvas) return ok(window.html2canvas);
    const s = document.createElement("script");
    s.src = HTML2CANVAS_URL;
    s.onload = () => ok(window.html2canvas);
    s.onerror = () => { html2canvasPromise = null; falha(new Error("Unable to load the image generator. Check your connection.")); };
    document.head.appendChild(s);
  });
  return html2canvasPromise;
}

async function salvarImagem(botao, d) {
  botao.disabled = true;
  const caixa = document.createElement("div");
  try {
    const capturar = await carregarHtml2canvas();
    const MES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mesEn = (ym) => `${MES[Number(ym.slice(5, 7)) - 1]}-${ym.slice(2, 4)}`;
    const n = (v) => {
      const txt = Math.round(Math.abs(Number(v) || 0)).toLocaleString("en-US");
      return v < 0 && txt !== "0" ? `(${txt})` : txt;
    };
    const cor = { texto: "#1b2e22", texto2: "#5a7a69", texto3: "#8aab97", borda: "#dde8e2", brand: "#2d4a3e", claro: "#e8f0ec", neg: "#c4291c", alerta: "#a35a00" };
    const td = (v, forte = false) => `<td style="text-align:right;padding:7px 14px;${forte ? "font-weight:700;" : ""}color:${v < 0 ? cor.neg : cor.texto}">${Math.abs(v) < 0.5 ? `<span style="color:${cor.texto3}">–</span>` : n(v)}</td>`;
    const card = (t, v, s, corV = cor.texto) => `<div style="flex:1;background:#fff;border:1px solid ${cor.borda};border-radius:10px;padding:12px 14px">
      <div style="font-size:11px;font-weight:600;color:${cor.texto3};text-transform:uppercase;letter-spacing:.03em">${esc(t)}</div>
      <div style="font-size:24px;font-weight:700;line-height:1.25;color:${corV}">${esc(v)}</div>
      <div style="font-size:11.5px;color:${cor.texto2}">${esc(s)}</div></div>`;
    const contratosEn = (k) => `${k} contract${k === 1 ? "" : "s"}`;
    const quando = d.atualizado ? new Date(d.atualizado).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    const fim = d.cert.inicio ? mesEn(mesAnterior(d.cert.inicio)) : null;

    const cards = [
      d.cert.inicio ? card("Opening stock", n(d.inicial), `end of ${fim}${d.cert.bloqueado && d.excluido ? ` · excl. ${d.cert.bloqueado.nome}` : ""}`) : "",
      card("Purchased", n(d.comprado), contratosEn(d.nCompras)),
      card("Sold (export)", n(-d.vendido), contratosEn(d.nVendas), d.vendido >= 0.5 ? cor.neg : cor.texto),
      card("Balance today", n(d.saldoHoje), d.gravadas ? "in stock, after the links" : `up to ${mesEn(d.atual)} · ${d.saldoHoje < 0 ? "short" : "long"}`, d.saldoHoje < 0 ? cor.neg : cor.texto),
      card("To buy", d.nec >= 0.5 ? n(d.nec) : "–", !d.mesNec ? "no shortfall ahead"
        : `${d.nec >= 0.5 ? "to cover up to" : "covered up to"} ${mesEn(d.mesNec)}${d.nec - d.necAntes >= 0.5 ? ` · ${n(d.nec - d.necAntes)} in the month` : ""}`,
        d.nec >= 0.5 ? cor.alerta : cor.texto),
    ].join("");

    const th = (t, dir = true) => `<th style="text-align:${dir ? "right" : "left"};padding:8px 14px;font-size:11.5px;font-weight:600;color:${cor.texto2};text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid ${cor.borda}">${t}</th>`;
    const linhas = d.meses.map((l) => `<tr style="border-top:1px solid ${cor.borda};${l.ym === d.atual ? `background:${cor.claro};` : ""}">
      <td style="padding:7px 14px">${l.ym === d.atual ? `<strong>${mesEn(l.ym)}</strong> <span style="color:${cor.texto2}">· today</span>` : mesEn(l.ym)}</td>
      ${td(l.compras)}${td(-l.vendas)}${td(l.saldo)}${td(l.acumulado, true)}</tr>`).join("");

    caixa.setAttribute("data-sem-traducao", "");
    caixa.style.cssText = `position:fixed;left:-10000px;top:0;width:920px;padding:24px;background:#f0f4f2;color:${cor.texto};font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13.5px;line-height:1.45`;
    caixa.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
        <img src="assets/logo_brascof.png" alt="" style="height:40px">
        <div style="flex:1">
          <div style="font-size:19px;font-weight:700;color:${cor.brand}">${esc(d.cert.nome)} (${esc(d.cert.codigo)}) · Long / short position</div>
          <div style="font-size:12px;color:${cor.texto2}">Digisul data as of ${esc(quando)}${d.cert.inicio ? ` · contracts starting ${mesEn(d.cert.inicio)}` : ""} · all figures in 60 kg bags</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">${cards}</div>
      <div style="background:#fff;border:1px solid ${cor.borda};border-radius:10px;overflow:hidden">
        <div style="padding:12px 14px 8px"><div style="font-size:15px;font-weight:700">Long / short by month</div>
          <div style="font-size:11.5px;color:${cor.texto2}">Purchases by due month · export sales by shipment month · running balance</div></div>
        <table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums">
          <thead><tr>${th("Month", false)}${th("Purchases")}${th("Sales")}${th("Net")}${th("Running balance")}</tr></thead>
          <tbody>${d.inicial ? `<tr style="background:#f7faf8"><td style="padding:7px 14px;font-style:italic">Opening stock <span style="color:${cor.texto2}">· end of ${fim}</span></td>
            <td></td><td></td><td></td>${td(d.inicial, true)}</tr>` : ""}${linhas}</tbody>
          ${d.meses.length ? `<tfoot><tr style="border-top:2px solid ${cor.borda};font-weight:700;background:#f7faf8"><td style="padding:8px 14px">Total</td>
            ${td(soma(d.meses, "compras"), true)}${td(-soma(d.meses, "vendas"), true)}${td(d.saldoFinal - d.inicial, true)}${td(d.saldoFinal, true)}</tr></tfoot>` : ""}
        </table>
      </div>`;
    document.body.appendChild(caixa);
    await Promise.all([...caixa.querySelectorAll("img")].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = i.onerror = ok; }))));
    await document.fonts?.ready;
    const canvas = await capturar(caixa, { scale: 2, backgroundColor: "#f0f4f2", logging: false, useCORS: true });
    const a = document.createElement("a");
    a.download = `${d.cert.codigo} Long Short ${hojeIso()}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  } catch (e) {
    toast(e.message, "erro");
  } finally {
    caixa.remove();
    botao.disabled = false;
  }
}
