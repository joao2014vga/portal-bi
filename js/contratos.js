// Future Contracts: página nativa do portal (card portal:contratos-futuros).
//
// Lista os contratos de compra FUTUROS do Digisul (ao vivo pelo brascof-api,
// /api/contratos-futuros) e junta o controle do Supabase (seção 36):
//   To do → Generated → Sent (ClickSign, aguardando assinatura) → Signed   (ou Not needed)
// Cada contrato abre o formulário de conferência, já preenchido com o Digisul, o cadastro do
// vendedor e o último documento gerado; dali sai o contrato em Word (js/contrato-docx.js).
// O status muda direto na linha da tabela, com quem e quando (gravado pelo banco).
import { esc, $, $$, icon, toast, modal, tempoRelativo, cabecalho as cabecalhoPagina } from "./ui.js";
import { fmtN, fmtData, ligarSegmentos } from "./position.js";
import {
  camposPadrao, conferir, gerarDocx, nomeArquivo, precoTexto, catacao, certificados, aFixar, reais, precoSugerido,
  ehPessoaJuridica, formatarIE, FATOR_PF,
} from "./contrato-docx.js";

export const ehPainelContratos = (link) => link === "portal:contratos-futuros";

const STATUS = {
  fazer: { rot: "To do", cls: "pill-alerta", dica: "No contract document yet" },
  gerado: { rot: "Generated", cls: "pill-adm", dica: "Document generated, not sent through ClickSign yet" },
  enviado: { rot: "Awaiting signature", cls: "pill", dica: "Sent through ClickSign, waiting for the signature" },
  assinado: { rot: "Signed", cls: "pill-ok", dica: "Signed" },
  dispensado: { rot: "Not needed", cls: "pill", dica: "This contract does not need the document" },
};
const ORDEM_STATUS = ["fazer", "gerado", "enviado", "assinado", "dispensado"];
const statusDe = (r) => r._ctr?.status ?? "fazer";
// "BRC-0555/26A" | "BRC-0555/26-2" → "BRC-0555/26" (mesma regra do Position)
const familia = (k) => String(k ?? "").trim().toUpperCase().replace(/^(.+\/\d{2})(?:-\d{1,3}|-?[A-Z]{1,2})$/, "$1");
const ehArabica = (r) => !r.especie || /AR[AÁ]BICA/i.test(r.especie);
const estado = { aba: "fazer", busca: "", especie: "arabica" };

function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30e3);
}

export async function renderContratos(link, alvo, ctx) {
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading future contracts from Digisul…</div>`;
  let digisul, controle, vendedores;
  const carregar = async (fresco = false) => {
    [digisul, controle, vendedores] = await Promise.all([
      ctx.api.contratosFuturosDigisul(fresco), ctx.api.ctrControle(), ctx.api.ctrVendedores()]);
  };
  try {
    await carregar();
  } catch (e) {
    alvo.innerHTML = `<div class="vazio">${icon("alert")}<h3>Future contracts are not available</h3><p>${esc(e.message)}</p>
      <button class="btn" id="ctrTentar">${icon("refresh")}<span>Try again</span></button></div>`;
    $("#ctrTentar", alvo)?.addEventListener("click", () => renderContratos(link, alvo, ctx));
    return;
  }
  let modelo = null; // carregado no primeiro documento

  const montarLinhas = () => {
    const ctr = new Map(controle.map((x) => [x.contrato, x]));
    const vend = new Map(vendedores.map((v) => [v.nome.toUpperCase(), v]));
    const doDigisul = new Set();
    const linhas = digisul.contratos.map((c) => {
      doDigisul.add(c.contrato);
      // contrato desmembrado ("BRC-0555/26A"): sem controle próprio, vale o do contrato-pai
      const pai = familia(c.contrato);
      const proprio = ctr.get(c.contrato) ?? null;
      return { ...c, _pai: pai !== c.contrato ? pai : null, _ctr: proprio ?? (pai !== c.contrato ? ctr.get(pai) ?? null : null),
        _herdado: !proprio && pai !== c.contrato && ctr.has(pai), _vend: vend.get(String(c.fornecedor ?? "").toUpperCase()) ?? null };
    });
    // no controle (planilha ou portal) mas fora da lista do Digisul: não é mais "Futuro" ou é de antes de 2026
    const pais = new Set(linhas.map((r) => r._pai).filter(Boolean));
    for (const x of controle) {
      // contrato-pai desmembrado: aparece pelas partes (A, B…), que herdam o status dele
      if (doDigisul.has(x.contrato) || pais.has(x.contrato)) continue;
      linhas.push({ contrato: x.contrato, fornecedor: x.dados?.vendedor_nome ?? null, sacas: x.dados?.sacas ?? null, _ctr: x, _fora: true });
    }
    return linhas.sort((a, b) => (b.emissao ?? "").localeCompare(a.emissao ?? "") || b.contrato.localeCompare(a.contrato));
  };
  let linhas = montarLinhas();

  const desenhar = () => {
    const base = linhas.filter((r) => estado.especie === "todas" || r._fora || ehArabica(r));
    const cont = Object.fromEntries(ORDEM_STATUS.map((s) => [s, base.filter((r) => statusDe(r) === s)]));
    const t = estado.busca.trim().toLowerCase();
    const lista = base.filter((r) => (estado.aba === "todos" || statusDe(r) === estado.aba)
      && (!t || [r.contrato, r.fornecedor, r.padrao, r.certificador, r.corretor].some((v) => String(v ?? "").toLowerCase().includes(t))));
    const kpi = (k, titulo, sub) => `<button type="button" class="pos-kpi ${estado.aba === k ? "on" : ""}" data-aba="${k}">
      <span class="pos-kpi-t">${esc(titulo)}</span><span class="pos-kpi-v">${fmtN(cont[k].length)}</span>
      <span class="pos-kpi-s">${fmtN(cont[k].reduce((s, r) => s + (Number(r.sacas) || 0), 0))} bags · ${esc(sub)}</span></button>`;
    const abas = `<nav class="cab-abas" role="tablist" id="ctrAba">${[["fazer", "To do"], ["gerado", "Generated"], ["enviado", "Awaiting signature"],
      ["assinado", "Signed"], ["dispensado", "Not needed"], ["todos", "All"]].map(([k, rot]) =>
      `<button type="button" role="tab" data-k="${k}" class="${k === estado.aba ? "on" : ""}" aria-selected="${k === estado.aba}">${esc(rot)} (${fmtN(k === "todos" ? base.length : cont[k].length)})</button>`).join("")}</nav>`;

    alvo.innerHTML = `<div class="pos">
      ${cabecalhoPagina({
        titulo: ctx.titulo || "Future Contracts",
        sub: `Digisul data <strong>${esc(tempoRelativo(digisul.consultadoEm))}</strong> · contracts with modality <strong>Futuro</strong> issued from 2026`,
        acoes: `<button class="btn" id="ctrSync" title="Fetch Digisul now">${icon("refresh")}<span>Update now</span></button>`,
        abas,
      })}
      <div class="pos-kpis">
        ${kpi("fazer", "To do", "no document yet")}
        ${kpi("gerado", "Generated", "to send through ClickSign")}
        ${kpi("enviado", "Awaiting signature", "sent through ClickSign")}
        ${kpi("assinado", "Signed", "done")}
      </div>
      <div class="pos-filtros">
        <label class="busca sm">${icon("search")}<input type="search" id="ctrBusca" placeholder="Search contract, seller, standard…" value="${esc(estado.busca)}"></label>
        <select id="ctrEspecie" aria-label="Species">
          <option value="arabica" ${estado.especie === "arabica" ? "selected" : ""}>Arabica only</option>
          <option value="todas" ${estado.especie === "todas" ? "selected" : ""}>Arabica and conilon</option></select>
      </div>
      <div class="pos-resumo">
        <span><strong>${fmtN(lista.length)}</strong> ${lista.length === 1 ? "contract" : "contracts"}</span>
        <span><strong>${fmtN(lista.reduce((s, r) => s + (Number(r.sacas) || 0), 0))}</strong> bags</span>
      </div>
      <div class="tabela-wrap pos-tabela pos-contratos"><table class="tabela tabela-num ctr-tabela">
        <thead><tr><th>Contract</th><th>Seller</th><th class="num">Bags</th><th>Issued</th><th>Due</th><th>Standard</th><th>Cup</th><th>Certificate</th>
          <th class="num" title="Contract price per bag: the one in the last document, or the Digisul average (+1% for individual sellers)">Price R$/bag</th><th>Status</th><th></th></tr></thead>
        <tbody>${lista.length ? lista.map(linhaHtml).join("") : `<tr><td colspan="11" class="vazio-td">No contracts here.</td></tr>`}</tbody>
      </table></div>
    </div>`;

    ligarSegmentos(alvo, "ctrAba", (k) => { estado.aba = k; desenhar(); });
    $$("[data-aba]", alvo).forEach((b) => b.addEventListener("click", () => { estado.aba = b.dataset.aba; desenhar(); }));
    const fb = $("#ctrBusca", alvo);
    fb.addEventListener("input", () => { estado.busca = fb.value; desenhar(); const n = $("#ctrBusca", alvo); n.focus(); n.setSelectionRange(estado.busca.length, estado.busca.length); });
    $("#ctrEspecie", alvo).addEventListener("change", (e) => { estado.especie = e.target.value; desenhar(); });
    $("#ctrSync", alvo).addEventListener("click", async (e) => {
      const b = e.currentTarget; b.disabled = true; b.classList.add("loading");
      try { await carregar(true); linhas = montarLinhas(); desenhar(); toast("Future contracts updated from Digisul."); }
      catch (err) { toast(err.message, "erro"); b.disabled = false; b.classList.remove("loading"); }
    });
    $$("[data-abrir]", alvo).forEach((b) => b.addEventListener("click", () => abrir(linhas.find((r) => r.contrato === b.dataset.abrir))));
    $$("select[data-status]", alvo).forEach((s) => s.addEventListener("change", () => mudarStatus(s.dataset.status, s.value, s)));
  };

  const linhaHtml = (r) => {
    const st = statusDe(r), S = STATUS[st];
    const cat = catacao(r);
    const certs = certificados(r.certificador);
    const quem = r._ctr ? [
      r._ctr.assinado_em && `signed ${fmtData(r._ctr.assinado_em.slice(0, 10))}${r._ctr.assinado_por ? ` by ${r._ctr.assinado_por}` : ""}`,
      r._ctr.enviado_em && `sent ${fmtData(r._ctr.enviado_em.slice(0, 10))}${r._ctr.enviado_por ? ` by ${r._ctr.enviado_por}` : ""}`,
      r._ctr.gerado_em && `generated ${fmtData(r._ctr.gerado_em.slice(0, 10))}${r._ctr.gerado_por ? ` by ${r._ctr.gerado_por}` : ""}`,
      r._ctr.origem === "planilha" && "imported from the control spreadsheet",
    ].filter(Boolean).join(" · ") : S.dica;
    return `<tr>
      <td class="nowrap"><button type="button" class="link" data-abrir="${esc(r.contrato)}" title="Check the data and generate the contract">${esc(r.contrato)}</button>
        ${r._fora ? ` <span class="pill" title="In the control, but not a Digisul future contract issued from 2026">Not in Digisul list</span>` : ""}
        ${r._pai ? ` <span class="pill" title="${esc(r._herdado ? `Split contract: the status shown is the one of ${r._pai}. Changing it here gives this part its own status.` : `Split contract: ${r._pai} is not in the control.`)}">Split from ${esc(r._pai)}</span>` : ""}</td>
      <td>${esc(r.fornecedor ?? "—")}${r._vend?.qualificacao || r._fora ? "" : ` <span class="pill pill-alerta" title="No seller data saved yet: fill in CPF/CNPJ and town when generating">New seller</span>`}</td>
      <td class="num">${r.sacas != null ? fmtN(r.sacas) : "—"}</td>
      <td>${r.emissao ? fmtData(r.emissao) : "—"}</td><td>${r.vencimento ? fmtData(r.vencimento) : "—"}</td>
      <td>${esc(r.padrao ?? "—")}${cat ? ` <span class="muted" title="Screen cleaning (catação)">· ${fmtN(cat)}%</span>` : ""}</td>
      <td>${esc(r.bebida ?? "—")}</td>
      <td>${certs.length ? esc(certs.join(", ")) : `<span class="muted">—</span>`}</td>
      <td class="num">${r._fora ? "—" : r._ctr?.dados?.preco ? fmtN(r._ctr.dados.preco, 2) : aFixar(r) ? `<span class="muted" title="Price to be fixed">to fix</span>` : fmtN(precoSugerido(r, null), 2)}</td>
      <td title="${esc(quem)}"><select data-status="${esc(r.contrato)}" class="ctr-status ${esc(st)}" aria-label="Status of ${esc(r.contrato)}">
        ${st === "fazer" ? `<option value="fazer" selected>To do</option>` : ""}
        ${ORDEM_STATUS.filter((k) => k !== "fazer").map((k) => `<option value="${k}" ${k === st ? "selected" : ""}>${esc(STATUS[k].rot)}</option>`).join("")}</select></td>
      <td class="nowrap">${r._fora ? "" : `<button type="button" class="btn btn-sm" data-abrir="${esc(r.contrato)}">${icon("file")}<span>${r._ctr?.dados ? "Open" : "Generate"}</span></button>`}</td>
    </tr>`;
  };

  const mudarStatus = async (contrato, status, sel) => {
    const r = linhas.find((x) => x.contrato === contrato);
    if (status === "fazer") return;
    sel.disabled = true;
    try {
      const [salvo] = await ctx.api.ctrSalvar({ contrato, status, ...(r?._ctr ? {} : { email: r?._vend?.email ?? null }) });
      controle = controle.filter((x) => x.contrato !== contrato).concat(salvo);
      linhas = montarLinhas();
      toast(`${contrato}: ${STATUS[status].rot}.`);
      desenhar();
    } catch (e) {
      toast(e.message, "erro");
      sel.disabled = false;
      sel.value = statusDe(r);
    }
  };

  // ---------------------------------------------------------------- formulário do contrato
  const abrir = (r) => {
    if (!r || r._fora) return;
    const f = camposPadrao(r, r._vend, r._herdado ? null : r._ctr);
    const st = statusDe(r);
    const pj = ehPessoaJuridica(f.documento);
    const precoDig = r.media > 1 ? `average ${reais(r.media)}${pj ? " (company: contract price = average)" : ` × ${String(FATOR_PF).replace(".", ",")} = ${reais(precoSugerido(r, null, f.documento))} (individual seller)`}` : "";
    const campo = (k, rot, { tipo = "text", dica = "", larga = false, linhas: nl = 0, extra = "" } = {}) => `<label class="campo ${larga ? "ctr-larga" : ""}"><span>${esc(rot)}</span>
      ${nl ? `<textarea name="${k}" rows="${nl}" ${extra}>${esc(f[k] ?? "")}</textarea>` : `<input name="${k}" type="${tipo}" value="${esc(f[k] ?? "")}" ${extra}>`}
      ${dica ? `<small class="muted">${dica}</small>` : ""}</label>`;
    const m = modal({
      titulo: `${r.contrato} · ${r.fornecedor ?? ""}`,
      largura: "modal-lg ctr-modal",
      botao: "Download Word",
      corpo: `
        <div class="ctr-digisul">
          <span><strong>Digisul</strong> ${esc(r.padrao ?? "")} · ${esc(r.bebida ?? "")} · ${esc(r.peneira ?? "")}</span>
          <span>${esc(r.certificador || "no certificate")} · ${esc(r.safra ?? "")} · ${r.sacas != null ? `${fmtN(r.sacas)} bags` : ""} · issued ${esc(r.emissao ? fmtData(r.emissao) : "—")} · due ${esc(r.vencimento ? fmtData(r.vencimento) : "—")}</span>
          <span>Price in Digisul: ${esc(precoDig || "to be fixed")}${r.corretor ? ` · broker ${esc(r.corretor)}` : ""}</span>
          <span>Status: <span class="pill ${STATUS[st].cls}">${esc(STATUS[st].rot)}</span>${r._ctr?.gerado_em ? ` <span class="muted">· last generated ${esc(fmtData(r._ctr.gerado_em.slice(0, 10)))}${r._ctr.gerado_por ? ` by ${esc(r._ctr.gerado_por)}` : ""}</span>` : ""}</span>
        </div>
        ${!r._vend?.qualificacao ? `<div class="aviso-inline alerta">${icon("alert")}<span>First contract for this seller in the portal: check the CPF/CNPJ, state registration and town in the seller line. They are saved for the next contracts.</span></div>` : ""}
        <p class="muted ctr-nota">Texts in Portuguese, as they go into the contract. <code>**text**</code> = bold, <code>__text__</code> = bold underlined.</p>
        <div class="form-grid ctr-form">
          ${campo("vendedor_nome", "Seller")}
          ${campo("documento", "CPF / CNPJ (signature)")}
          ${campo("qualificacao", "Seller line (after the name)", { larga: true, linhas: 2 })}
          ${campo("sacas", "Bags", { tipo: "number", extra: 'step="any" min="0"' })}
          ${campo("safra", "Crop", { dica: "e.g. 27/28" })}
          ${campo("descricao", "Coffee description (after “Café arábica,”)", { larga: true, linhas: 5 })}
          ${campo("data_negocio", "Deal confirmed by e-mail on", { dica: "dd/mm/yyyy" })}
          ${campo("data_assinatura", "Signing date (Varginha, …)", { dica: "dd/mm/yyyy" })}
          ${campo("entrega_ini", "Delivery from", { dica: "dd/mm/yyyy" })}
          ${campo("entrega_fim", "Delivery to", { dica: "dd/mm/yyyy" })}
          ${campo("entrega_local", "Delivery place", { larga: true, dica: "e.g. na cidade do vendedor · no armazém do vendedor" })}
          ${campo("preco", "Contract price per bag (R$)", { tipo: "number", extra: 'step="0.01" min="0"', dica: "Suggested from Digisul: the average, +1% for individual sellers (rule checked against the 2026 contracts). Check it: changing it rewrites the price clause." })}
          ${campo("email", "Seller e-mail (ClickSign)", { tipo: "email" })}
          ${campo("preco_texto", "Price clause (after “da safra 27/28,”)", { larga: true, linhas: 3 })}
        </div>
        <ul class="ctr-erros" aria-live="polite"></ul>
        <p class="muted ctr-nota">Downloading saves what was generated: the status becomes Generated (if it was To do) and the seller line is kept for the next contracts.</p>`,
      onOpen: (form) => {
        const preco = form.elements.preco, sacas = form.elements.sacas, clausula = form.elements.preco_texto;
        const reescrever = () => { clausula.value = precoTexto({ preco: preco.value, sacas: sacas.value }); };
        preco.addEventListener("input", reescrever);
        sacas.addEventListener("input", () => { if (Number(preco.value) > 0) reescrever(); });
      },
      onSubmit: async (form) => {
        const { campos, blob } = await gerar(form);
        baixar(blob, nomeArquivo(campos.contrato));
        toast(`${campos.contrato}: Word downloaded.`);
      },
    });

    // lê o formulário, confere, gera o .docx e grava o controle e o vendedor
    const gerar = async (form) => {
      const el = form.elements;
      const campos = { ...f };
      for (const k of Object.keys(f)) if (el[k]) campos[k] = el[k].value.trim();
      campos.sacas = Number(campos.sacas);
      campos.preco = campos.preco === "" ? null : Number(campos.preco);
      const erros = conferir(campos);
      $(".ctr-erros", form).innerHTML = erros.map((x) => `<li>${esc(x)}</li>`).join("");
      if (erros.length) throw new Error("Fix the items above before generating.");
      modelo ??= await ctx.api.ctrModelo();
      if (!modelo?.conteudo) throw new Error("The contract template has not been uploaded yet. Ask the administrator.");
      const blob = await gerarDocx(modelo.conteudo, campos);
      const { email, ...dados } = campos;
      const atual = controle.find((x) => x.contrato === r.contrato)?.status ?? "fazer";
      const [salvo] = await ctx.api.ctrSalvar({ contrato: r.contrato, status: atual === "fazer" ? "gerado" : atual, email: email || null, dados });
      controle = controle.filter((x) => x.contrato !== r.contrato).concat(salvo);
      // a qualificação vale para os próximos contratos do vendedor (pelo nome do Digisul)
      const nomeDig = String(r.fornecedor ?? campos.vendedor_nome).toUpperCase();
      await ctx.api.ctrSalvarVendedor({
        nome: nomeDig, documento: campos.documento, qualificacao: campos.qualificacao, email: email || r._vend?.email || null,
        cidade: r._vend?.cidade ?? r.cidade ?? null, uf: r._vend?.uf ?? null, ie: r._vend?.ie || formatarIE(r.fornecedor_ie) || null,
      }).then(() => { vendedores = vendedores.filter((v) => v.nome.toUpperCase() !== nomeDig).concat({ ...(r._vend ?? {}), nome: nomeDig, qualificacao: campos.qualificacao, documento: campos.documento, email: email || r._vend?.email || null }); })
        .catch((e) => toast(`Seller data not saved: ${e.message}`, "erro"));
      linhas = montarLinhas();
      desenhar();
      return { campos, blob };
    };
    return m;
  };

  desenhar();
}
