// =====================================================================
// PRICE LIST — "Prices updated"
// Diferenciais por cliente (ex.: Melitta fine = BC5 -22), editados no próprio
// portal e mandados no grupo interno como imagem ou PDF (WhatsApp, e-mail,
// Teams), com a logo e as cores da Brascof. Tudo na folha se edita no lugar:
// título, período, países, clientes, qualidade, padrão e o dif.
//
// Cada card com link "portal:precos-<chave>" é uma lista própria
// (ex.: portal:precos-europe, portal:precos-usa), gravada em bi_precos
// (seção 26 do supabase/schema.sql).
// =====================================================================
import { esc, $, $$, icon, toast, confirmar, tempoRelativo, cabecalho, storage, carregarScript } from "./ui.js";

export const ehPainelPrecos = (link) => /^portal:precos-/.test(link ?? "");

const HTML2CANVAS = ["https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js", "html2canvas"];
const JSPDF = ["https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", "jspdf"];

// cores da marca (as do cabeçalho das páginas), fixas na imagem: sai igual no tema escuro
const COR = { faixa: "#1d4a3d", brand: "#2d4a3e", fundo: "#f0f4f2", borda: "#dde8e2", texto: "#1b2e22", texto2: "#5a7a69", claro: "#e8f0ec" };
const FONTE = `Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;

const CAMPOS = ["cliente", "qualidade", "padrao", "dif"];
const linhaNova = (cliente = "", qualidade = "", padrao = "", dif = "") => ({ cliente, qualidade, padrao, dif });
// extras: custos e prêmios somados ao preço (ex.: EUDR 2 cents, RFA 5 cents)
const extraNovo = (nome = "", valor = "") => ({ nome, valor });

// ponto de partida de uma lista nova: o exemplo que o comercial manda hoje
const MODELO = () => ({
  titulo: "Prices updated",
  periodo: "January to June",
  grupos: [
    { nome: "Germany", linhas: [
      linhaNova("Melitta", "fine", "BC5", "-25"),
      linhaNova("Dallmayr", "good", "BC5+", "-18"),
      linhaNova("Darboven", "good", "BC6-", "-35"),
      linhaNova("Coffeein", "good", "BC5", "-25"),
      linhaNova("Westhoff", "fine", "BC6", "-35"),
      linhaNova("LIDL", "fine", "BC6-", "-35"),
      linhaNova("LIDL", "grinders 12up", "", "-65"),
    ] },
    { nome: "", linhas: [
      linhaNova("JDE", "Primeiro", "BC5", "-25"),
      linhaNova("JJ", "quality", "BC5", "-25"),
      linhaNova("Lavazza", "", "LA3", ""),
      linhaNova("Lavazza", "", "LA6", ""),
    ] },
    { nome: "", linhas: [
      linhaNova("Mother Parker", "", "BC3", "+2"),
      linhaNova("Gavin", "", "BC3", "+2"),
      linhaNova("Folger", "", "C", "-60"),
      linhaNova("Folger", "", "B", "-35"),
    ] },
  ],
  extras: [extraNovo("EUDR", "2 cents"), extraNovo("RFA", "5 cents")],
  nota: "Please add the uplift (financial costs, packages and certified)\nVolume to be confirmed",
});

// garante o formato (dado antigo ou editado à mão no banco não quebra a tela)
function normalizar(d) {
  const s = (v) => (v == null ? "" : String(v));
  return {
    titulo: s(d?.titulo), periodo: s(d?.periodo),
    grupos: (Array.isArray(d?.grupos) ? d.grupos : []).map((g) => ({
      nome: s(g?.nome),
      linhas: (Array.isArray(g?.linhas) ? g.linhas : []).map((l) => linhaNova(s(l?.cliente), s(l?.qualidade), s(l?.padrao), s(l?.dif))),
    })),
    extras: (Array.isArray(d?.extras) ? d.extras : []).map((x) => extraNovo(s(x?.nome), s(x?.valor))),
    nota: s(d?.nota),
  };
}

// observações: uma por linha, sem espaços sobrando nem linhas em branco repetidas
const linhasNota = (v) => v.split(/\r?\n/).map((x) => x.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

// o que vai para o banco e para a imagem: sem espaços sobrando, sem linhas e grupos vazios
function limpo(d) {
  const t = (v) => v.trim();
  return {
    titulo: t(d.titulo), periodo: t(d.periodo),
    grupos: d.grupos
      .map((g) => ({ nome: t(g.nome), linhas: g.linhas.map((l) => linhaNova(t(l.cliente), t(l.qualidade), t(l.padrao), fmtDif(l.dif))).filter((l) => CAMPOS.some((c) => l[c])) }))
      .filter((g) => g.nome || g.linhas.length),
    extras: d.extras.map((x) => extraNovo(t(x.nome), t(x.valor))).filter((x) => x.nome || x.valor),
    nota: linhasNota(d.nota),
  };
}

// "-22", "+5", "5" → "+5", "0" / "lvl" → "Level"; o resto fica como foi digitado
export function fmtDif(v) {
  const bruto = String(v ?? "").trim();
  const s = bruto.replace(/[−–]/g, "-").replace(/\s+/g, "");
  if (!s) return "";
  if (/^(level|lvl|lv|[+-]?0+([.,]0+)?)$/i.test(s)) return "Level";
  if (/^[+-]?\d+([.,]\d+)?$/.test(s)) {
    const n = Number(s.replace(",", "."));
    return (n > 0 ? "+" : "") + String(n);
  }
  return bruto;
}

// mesma linha na versão salva (para mostrar "was -22" quando o dif muda)
const chaveLinha = (g, l) => [g.nome, l.cliente, l.qualidade, l.padrao].map((x) => x.trim().toLowerCase()).join("|");

const dataCurta = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const hojeIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const nomeArquivo = (d) => `${(d.titulo || "Prices").replace(/[\\/:*?"<>|]+/g, " ").trim()} ${hojeIso()}`;

// texto no formato que já circula no WhatsApp (*negrito*, _itálico_)
function texto(d) {
  const l = [`*${d.titulo || "Prices"}*`];
  if (d.periodo) l.push(`_${d.periodo}_`);
  for (const g of d.grupos) {
    l.push("");
    if (g.nome) l.push(`*${g.nome}*`);
    for (const r of g.linhas) {
      // como circula: "Melitta fine = BC5 -25", mas sem qualidade o padrão vai antes: "Folger C = -60"
      const quem = [r.cliente, r.qualidade || r.padrao].filter(Boolean).join(" ");
      const preco = [r.qualidade ? r.padrao : "", r.dif].filter(Boolean).join(" ");
      // sem dif (preço ainda em aberto) fica "Lavazza LA3 =", como já circula
      l.push(quem ? `${quem} = ${preco}`.trimEnd() : preco);
    }
  }
  if (d.extras.length) l.push("", ...d.extras.map((x) => [x.nome, x.valor].filter(Boolean).join(" ")));
  if (d.nota) l.push("", d.nota);
  return l.join("\n");
}

// =====================================================================
// TELA
// =====================================================================
export async function renderPrecos(link, alvo, ctx) {
  const chave = link.replace(/^portal:precos-/, "");
  const CHAVE_RASCUNHO = `portalbi_precos_rascunho_${chave}`;
  alvo.innerHTML = `<div class="pos-carregando"><span class="spinner"></span> Loading prices…</div>`;
  let reg;
  try {
    reg = await ctx.api.precos(chave);
  } catch (e) {
    alvo.innerHTML = `<div class="pos"><div class="vazio">${icon("lock")}<h3>Price list unavailable</h3><p>${esc(e.message)}</p></div></div>`;
    return;
  }

  let salvo = reg?.dados ? normalizar(reg.dados) : null;
  let meta = { em: reg?.atualizado_em ?? null, por: reg?.atualizado_por ?? null };
  let dados = structuredClone(salvo ?? MODELO());

  // rascunho: o que foi digitado e não salvo volta se a pessoa sair da página sem querer.
  // base = atualizado_em da versão salva sobre a qual a edição começou: se a lista foi salva
  // de novo depois (ou o rascunho é antigo, sem base), ele não volta, senão desfaria a lista nova
  try {
    const r = JSON.parse(storage.get(CHAVE_RASCUNHO) ?? "null");
    if (r?.dados && JSON.stringify(normalizar(r.dados)) !== JSON.stringify(salvo)) {
      if (salvo && (r.base ?? null) !== meta.em) {
        storage.del(CHAVE_RASCUNHO);
        toast("An old unsaved draft was discarded: the list was updated by someone else in the meantime.", "notif");
      } else {
        dados = normalizar(r.dados);
        toast("Your unsaved changes were restored.");
      }
    } else storage.del(CHAVE_RASCUNHO);
  } catch { storage.del(CHAVE_RASCUNHO); }

  const sujo = () => !salvo || JSON.stringify(limpo(dados)) !== JSON.stringify(limpo(salvo));
  const guardarRascunho = () => {
    if (salvo && !sujo()) storage.del(CHAVE_RASCUNHO);
    else storage.set(CHAVE_RASCUNHO, JSON.stringify({ dados, em: new Date().toISOString(), base: meta.em }));
  };

  // fechar a aba com alteração não salva: o navegador pergunta
  const aoSair = (e) => {
    if (!alvo.isConnected) { window.removeEventListener("beforeunload", aoSair); return; }
    if (salvo && sujo()) { e.preventDefault(); e.returnValue = ""; }
  };
  window.addEventListener("beforeunload", aoSair);

  const anteriores = () => {
    const m = new Map();
    salvo?.grupos.forEach((g) => g.linhas.forEach((l) => m.set(chaveLinha(g, l), fmtDif(l.dif))));
    return m;
  };
  // "was -22" ao lado do valor alterado (só na tela; a imagem sai limpa)
  const rotuloAntes = (v, atual, preenchido) => {
    if (!salvo) return null;
    if (v === undefined) return preenchido ? "new" : null;
    return v === atual ? null : `was ${v || "–"}`;
  };
  const antes = (mapa, g, l) => rotuloAntes(mapa.get(chaveLinha(g, l)), fmtDif(l.dif), !!(l.cliente.trim() || l.dif.trim()));
  const extrasAnteriores = () => new Map((salvo?.extras ?? []).map((x) => [x.nome.trim().toLowerCase(), x.valor.trim()]));
  const antesExtra = (mapa, x) => rotuloAntes(mapa.get(x.nome.trim().toLowerCase()), x.valor.trim(), !!(x.nome.trim() || x.valor.trim()));
  // a caixa de observações cresce com o texto
  const ajustarAltura = (ta) => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };

  const inp = (attrs, valor, ph, cls) => `<input class="precos-in ${cls}" ${attrs} value="${esc(valor)}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" autocomplete="off" spellcheck="false">`;

  const htmlLinha = (mapa, g, gi, l, li) => {
    const a = antes(mapa, g, l);
    return `<div class="precos-linha ${a ? "mudou" : ""}" data-gi="${gi}" data-li="${li}">
      ${inp(`data-c="cliente"`, l.cliente, "Client", "precos-cli")}
      ${inp(`data-c="qualidade"`, l.qualidade, "Quality", "precos-qual")}
      ${inp(`data-c="padrao"`, l.padrao, "Grade", "precos-pad")}
      <span class="precos-dif-box">
        ${inp(`data-c="dif" inputmode="text"`, l.dif, "Diff", "precos-dif")}
        <small class="precos-antes">${a ? esc(a) : ""}</small>
      </span>
      <span class="precos-ctrl">
        <button type="button" class="btn-icon" data-mover-linha="-1" title="Move up" aria-label="Move up" ${li === 0 ? "disabled" : ""}>${icon("up")}</button>
        <button type="button" class="btn-icon" data-mover-linha="1" title="Move down" aria-label="Move down" ${li === g.linhas.length - 1 ? "disabled" : ""}>${icon("down")}</button>
        <button type="button" class="btn-icon perigo" data-tirar-linha title="Remove client" aria-label="Remove client">${icon("trash")}</button>
      </span>
    </div>`;
  };

  const htmlGrupo = (mapa, g, gi) => `<section class="precos-grupo" data-gi="${gi}">
    <div class="precos-grupo-h">
      ${inp(`data-c="nome"`, g.nome, "Country / group (optional)", "precos-pais")}
      <span class="precos-ctrl">
        <button type="button" class="btn-icon" data-mover-grupo="-1" title="Move group up" aria-label="Move group up" ${gi === 0 ? "disabled" : ""}>${icon("up")}</button>
        <button type="button" class="btn-icon" data-mover-grupo="1" title="Move group down" aria-label="Move group down" ${gi === dados.grupos.length - 1 ? "disabled" : ""}>${icon("down")}</button>
        <button type="button" class="btn-icon perigo" data-tirar-grupo title="Remove group" aria-label="Remove group">${icon("trash")}</button>
      </span>
    </div>
    <div class="precos-linhas">${g.linhas.map((l, li) => htmlLinha(mapa, g, gi, l, li)).join("")}</div>
    <button type="button" class="link precos-add" data-add-linha>${icon("plus")}Add client</button>
  </section>`;

  const htmlExtra = (mapa, x, ei) => {
    const a = antesExtra(mapa, x);
    return `<div class="precos-linha precos-extra ${a ? "mudou" : ""}" data-ei="${ei}">
      ${inp(`data-x="nome"`, x.nome, "Extra (e.g. EUDR)", "precos-cli")}
      <span class="precos-dif-box precos-val-box">
        ${inp(`data-x="valor"`, x.valor, "Value (e.g. 2 cents)", "precos-dif precos-val")}
        <small class="precos-antes">${a ? esc(a) : ""}</small>
      </span>
      <span class="precos-ctrl">
        <button type="button" class="btn-icon" data-mover-extra="-1" title="Move up" aria-label="Move up" ${ei === 0 ? "disabled" : ""}>${icon("up")}</button>
        <button type="button" class="btn-icon" data-mover-extra="1" title="Move down" aria-label="Move down" ${ei === dados.extras.length - 1 ? "disabled" : ""}>${icon("down")}</button>
        <button type="button" class="btn-icon perigo" data-tirar-extra title="Remove extra" aria-label="Remove extra">${icon("trash")}</button>
      </span>
    </div>`;
  };

  const htmlExtras = () => `<section class="precos-grupo precos-extras">
    <div class="precos-grupo-h"><span class="precos-secao">Extras</span><span class="precos-secao-dica">EUDR, RFA, certification… on top of the diff</span></div>
    <div class="precos-linhas">${dados.extras.map((x, ei) => htmlExtra(extrasAnteriores(), x, ei)).join("")}</div>
    <button type="button" class="link precos-add" data-add-extra>${icon("plus")}Add extra</button>
  </section>`;

  const desenhar = (foco = null) => {
    const rolagem = alvo.scrollTop;
    const mapa = anteriores();
    const quando = !salvo || sujo() ? new Date().toISOString() : meta.em;
    alvo.innerHTML = `<div class="pos precos">
      ${cabecalho({
        titulo: ctx.titulo || "Price list",
        data: meta.em ? dataCurta(meta.em) : "",
        sub: meta.em ? `Saved <strong>${esc(tempoRelativo(meta.em))}</strong>${meta.por ? ` by ${esc(meta.por)}` : ""}` : "Not saved yet",
        acoes: `<button class="btn" id="prTexto" title="Copy as text, ready to paste on WhatsApp">${icon("copy")}<span>Copy text</span></button>
          <button class="btn" id="prCopiar" title="Copy the image to paste on WhatsApp Web, Teams or e-mail">${icon("image")}<span>Copy image</span></button>
          <button class="btn" id="prImagem" title="Download as an image (PNG)">${icon("download")}<span>Save image</span></button>
          <button class="btn" id="prPdf" title="Download as PDF">${icon("file")}<span>Save PDF</span></button>
          <button class="btn btn-primary" id="prSalvar">${icon("check")}<span>Save</span></button>`,
      })}
      <div class="precos-barra">
        <span class="precos-estado" id="prEstado" aria-live="polite"></span>
        <span class="dica">${icon("info")}Click any text to edit it. Diff: -22, +5 or Level. Enter jumps to the next diff.</span>
      </div>
      <article class="precos-folha" aria-label="Price list">
        <header class="precos-topo">
          <span class="precos-logo"><img src="assets/logo_brascof.png" alt="Brascof"></span>
          <div class="precos-tit">
            ${inp(`data-campo="titulo"`, dados.titulo, "Title", "precos-h1")}
            ${inp(`data-campo="periodo"`, dados.periodo, "Period (e.g. January to June)", "precos-periodo")}
          </div>
          <span class="precos-data" id="prData" data-sem-traducao>${esc(dataCurta(quando))}</span>
        </header>
        <div class="precos-corpo">
          <div class="precos-colunas" aria-hidden="true"><span>Client</span><span>Quality</span><span>Grade</span><span>Diff</span><span></span></div>
          ${dados.grupos.map((g, gi) => htmlGrupo(mapa, g, gi)).join("")}
          <button type="button" class="btn btn-ghost precos-add-grupo" data-add-grupo>${icon("plus")}<span>Add country / group</span></button>
          ${htmlExtras()}
          <div class="precos-notas">
            <textarea class="precos-in precos-nota" data-campo="nota" rows="2" spellcheck="false" aria-label="Notes"
              placeholder="Notes (optional), one per line, e.g. Volume to be confirmed">${esc(dados.nota)}</textarea>
          </div>
        </div>
        <footer class="precos-rodape"><span class="precos-marca">Brascof · internal use</span></footer>
      </article>
    </div>`;
    ajustarAltura($(".precos-nota", alvo));
    alvo.scrollTop = rolagem;
    ligarAcoes(); // os botões do cabeçalho são novos a cada desenho
    atualizarEstado();
    if (foco) $(foco, alvo)?.focus();
  };

  const atualizarEstado = () => {
    const s = sujo();
    const b = $("#prSalvar", alvo);
    if (b) b.disabled = !s;
    const e = $("#prEstado", alvo);
    if (e) e.innerHTML = !salvo
      ? `<span class="precos-pendente">${icon("info")}New list: adjust it and click Save.</span>`
      : s ? `<span class="precos-pendente">${icon("edit")}Unsaved changes</span> <button type="button" class="link" id="prDescartar">Discard</button>`
        : `<span class="precos-ok">${icon("check")}All changes saved</span>`;
    $("#prDescartar", alvo)?.addEventListener("click", descartar);
  };

  const descartar = async () => {
    if (!(await confirmar("Discard changes?", "The list goes back to the last saved version.", "Discard"))) return;
    dados = structuredClone(salvo ?? MODELO());
    storage.del(CHAVE_RASCUNHO);
    desenhar();
  };

  const salvar = async (btn) => {
    btn.disabled = true; btn.classList.add("loading");
    try {
      // só grava se a lista no banco ainda é a que foi aberta (meta.em); senão não passa por cima
      const r = await ctx.api.salvarPrecos(chave, limpo(dados), meta.em);
      if (!r) {
        btn.classList.remove("loading"); btn.disabled = false;
        const recarregar = await confirmar("Not saved",
          "Someone else saved this list after you opened it. Reload the page to see their version. Your changes here will be lost: use Copy text first if you want to keep them.",
          "Reload");
        if (recarregar) { window.removeEventListener("beforeunload", aoSair); location.reload(); }
        return;
      }
      salvo = normalizar(r.dados);
      dados = structuredClone(salvo);
      meta = { em: r.atualizado_em, por: r.atualizado_por };
      storage.del(CHAVE_RASCUNHO);
      toast("Prices saved.");
      desenhar();
    } catch (e) {
      toast(e.message, "erro");
      btn.classList.remove("loading"); btn.disabled = false;
    }
  };

  // ------------------------------------------------------------ edição no lugar
  const posicao = (el) => {
    const l = el.closest("[data-li]"), g = el.closest("[data-gi]");
    return { gi: g ? Number(g.dataset.gi) : null, li: l ? Number(l.dataset.li) : null };
  };

  alvo.addEventListener("input", (e) => {
    const el = e.target.closest(".precos-in");
    if (!el) return;
    if (el.dataset.campo) {
      dados[el.dataset.campo] = el.value;
      if (el.matches("textarea")) ajustarAltura(el);
    } else if (el.dataset.x) {
      const ei = Number(el.closest("[data-ei]").dataset.ei);
      dados.extras[ei][el.dataset.x] = el.value;
      const linhaEl = el.closest(".precos-linha");
      const a = antesExtra(extrasAnteriores(), dados.extras[ei]);
      linhaEl.classList.toggle("mudou", !!a);
      $(".precos-antes", linhaEl).textContent = a ?? "";
    } else {
      const { gi, li } = posicao(el);
      if (li == null) dados.grupos[gi][el.dataset.c] = el.value;
      else {
        dados.grupos[gi].linhas[li][el.dataset.c] = el.value;
        const linhaEl = el.closest(".precos-linha");
        const a = antes(anteriores(), dados.grupos[gi], dados.grupos[gi].linhas[li]);
        linhaEl.classList.toggle("mudou", !!a);
        $(".precos-antes", linhaEl).textContent = a ?? "";
      }
    }
    $("#prData", alvo).textContent = dataCurta(new Date().toISOString());
    atualizarEstado();
    guardarRascunho();
  });

  // dif no padrão ao sair do campo (5 → +5, 0 → Level)
  alvo.addEventListener("change", (e) => {
    const el = e.target.closest(".precos-dif:not(.precos-val)"); // o valor dos extras fica como foi digitado
    if (!el) return;
    const v = fmtDif(el.value);
    if (v === el.value) return;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Enter: no dif vai para o próximo dif (atualizar a lista toda de cima a baixo);
  // nos outros campos, para o campo seguinte; nas observações, Enter quebra a linha
  alvo.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("input.precos-in")) return;
    e.preventDefault();
    const lista = $$(e.target.matches(".precos-dif") ? ".precos-dif" : ".precos-in", alvo);
    const prox = lista[lista.indexOf(e.target) + 1];
    if (prox) { prox.focus(); prox.select(); } else e.target.blur();
  });

  alvo.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || !alvo.contains(b)) return;
    const { gi, li } = posicao(b);
    const mover = (lista, de, passo) => { const [x] = lista.splice(de, 1); lista.splice(de + passo, 0, x); };

    if (b.matches("[data-add-linha]")) {
      dados.grupos[gi].linhas.push(linhaNova());
      desenhar(`.precos-grupo[data-gi="${gi}"] .precos-linha:last-child .precos-cli`);
    } else if (b.matches("[data-add-grupo]")) {
      dados.grupos.push({ nome: "", linhas: [linhaNova()] });
      desenhar(`.precos-grupo[data-gi="${dados.grupos.length - 1}"] .precos-pais`);
    } else if (b.matches("[data-add-extra]")) {
      dados.extras.push(extraNovo());
      desenhar(`.precos-extra:last-child .precos-cli`);
    } else if (b.matches("[data-mover-extra]")) {
      const ei = Number(b.closest("[data-ei]").dataset.ei);
      mover(dados.extras, ei, Number(b.dataset.moverExtra));
      desenhar();
    } else if (b.matches("[data-tirar-extra]")) {
      dados.extras.splice(Number(b.closest("[data-ei]").dataset.ei), 1);
      desenhar();
    } else if (b.matches("[data-mover-linha]")) {
      mover(dados.grupos[gi].linhas, li, Number(b.dataset.moverLinha));
      desenhar();
    } else if (b.matches("[data-mover-grupo]")) {
      mover(dados.grupos, gi, Number(b.dataset.moverGrupo));
      desenhar();
    } else if (b.matches("[data-tirar-linha]")) {
      dados.grupos[gi].linhas.splice(li, 1);
      desenhar();
    } else if (b.matches("[data-tirar-grupo]")) {
      const g = dados.grupos[gi];
      const cheias = g.linhas.filter((l) => CAMPOS.some((c) => l[c].trim())).length;
      if (cheias && !(await confirmar("Remove group?", `${esc(g.nome.trim() || "This group")} and its ${cheias} client${cheias === 1 ? "" : "s"} leave the list.`, "Remove"))) return;
      dados.grupos.splice(gi, 1);
      desenhar();
    } else return;
    guardarRascunho();
  });

  // ------------------------------------------------------------ envio
  const lembrar = () => { if (salvo && sujo()) toast("Remember to click Save so everyone sees the new prices."); };

  const acao = (id, fn) => $(`#${id}`, alvo)?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, "erro"); } finally { btn.disabled = false; atualizarEstado(); }
  });

  const ligarAcoes = () => {
    $("#prSalvar", alvo)?.addEventListener("click", (ev) => salvar(ev.currentTarget));
    acao("prTexto", async () => {
      await navigator.clipboard.writeText(texto(limpo(dados)));
      toast("Text copied: paste it on WhatsApp, Teams or e-mail.");
      lembrar();
    });
    acao("prCopiar", async () => {
      if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("This browser cannot copy images. Use Save image.");
      // a promessa vai direto para o ClipboardItem: o Safari só aceita assim
      const blob = gerarCanvas(limpo(dados)).then((c) => new Promise((ok) => c.toBlob(ok, "image/png")));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Image copied: paste it (Ctrl+V) on WhatsApp Web, Teams or e-mail.");
      lembrar();
    });
    acao("prImagem", async () => {
      const d = limpo(dados);
      const c = await gerarCanvas(d);
      baixar(c.toDataURL("image/png"), `${nomeArquivo(d)}.png`);
      lembrar();
    });
    acao("prPdf", async () => {
      const d = limpo(dados);
      const [{ jsPDF }, c] = await Promise.all([carregarScript(...JSPDF), gerarCanvas(d)]);
      // largura de uma folha A4 e altura proporcional: abre bem no celular e imprime em A4
      const w = 595.28, h = (c.height / c.width) * w;
      const pdf = new jsPDF({ orientation: h >= w ? "portrait" : "landscape", unit: "pt", format: [w, h] });
      // JPEG: o PNG entra quase sem compressão no PDF (vários MB, pesado para o WhatsApp)
      pdf.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, w, h);
      pdf.setProperties({ title: d.titulo || "Prices", author: "Brascof" });
      pdf.save(`${nomeArquivo(d)}.pdf`);
      lembrar();
    });
  };

  desenhar();
}

// =====================================================================
// IMAGEM (e base do PDF): sempre no tema claro, em inglês, largura fixa
// =====================================================================
function montarImagem(d) {
  const caixa = document.createElement("div");
  caixa.setAttribute("data-sem-traducao", "");
  caixa.style.cssText = `position:fixed;left:-10000px;top:0;width:760px;background:${COR.fundo};color:${COR.texto};font-family:${FONTE};font-size:15px;line-height:1.4`;
  const grupo = (g) => `<div style="background:#fff;border:1px solid ${COR.borda};border-radius:12px;margin-bottom:14px;overflow:hidden">
    ${g.nome ? `<div style="padding:11px 20px;background:${COR.claro};border-bottom:1px solid ${COR.borda};font-size:13px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COR.brand}">${esc(g.nome)}</div>` : ""}
    <table style="width:100%;border-collapse:collapse">${g.linhas.map((l, i) => {
      const borda = i ? `border-top:1px solid ${COR.borda};` : "";
      return `<tr>
        <td style="${borda}padding:11px 20px"><span style="font-weight:600">${esc(l.cliente)}</span>${l.qualidade ? ` <span style="color:${COR.texto2}">${esc(l.qualidade)}</span>` : ""}</td>
        <td style="${borda}padding:11px 8px;width:96px;text-align:center">${l.padrao ? `<span style="display:inline-block;padding:2px 11px;border-radius:999px;background:${COR.claro};color:${COR.brand};font-weight:600;font-size:13.5px">${esc(l.padrao)}</span>` : ""}</td>
        <td style="${borda}padding:11px 20px;width:96px;text-align:right;font-weight:700;font-size:17px;font-variant-numeric:tabular-nums;color:${COR.faixa};white-space:nowrap">${esc(l.dif.replace(/^-(?=\d)/, "−")) || "–"}</td>
      </tr>`;
    }).join("")}</table>
  </div>`;
  caixa.innerHTML = `
    <div style="background:${COR.faixa};padding:22px 28px;display:flex;align-items:center;gap:18px">
      <div style="width:70px;height:70px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;flex:none">
        <img src="assets/logo_brascof.png" alt="" style="width:64px;height:64px;object-fit:contain;border-radius:50%"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:28px;font-weight:700;color:#fff;line-height:1.2">${esc(d.titulo || "Prices")}</div>
        ${d.periodo ? `<div style="font-size:16px;color:rgba(255,255,255,.82);margin-top:3px">${esc(d.periodo)}</div>` : ""}
      </div>
      <div style="border:1.5px solid rgba(255,255,255,.75);border-radius:999px;padding:4px 14px;font-size:14px;font-weight:600;color:#fff;white-space:nowrap">${esc(dataCurta(new Date().toISOString()))}</div>
    </div>
    <div style="padding:20px 28px 6px">
      ${d.grupos.map(grupo).join("")}
      ${d.extras.length ? `<div style="background:#fff;border:1px solid ${COR.borda};border-radius:12px;margin-bottom:14px;overflow:hidden">
        <div style="padding:11px 20px;background:${COR.claro};border-bottom:1px solid ${COR.borda};font-size:13px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${COR.brand}">Extras</div>
        <table style="width:100%;border-collapse:collapse">${d.extras.map((x, i) => {
          const borda = i ? `border-top:1px solid ${COR.borda};` : "";
          return `<tr><td style="${borda}padding:11px 20px;font-weight:600">${esc(x.nome)}</td>
            <td style="${borda}padding:11px 20px;text-align:right;font-weight:700;font-size:16px;color:${COR.faixa};white-space:nowrap">${esc(x.valor) || "–"}</td></tr>`;
        }).join("")}</table>
      </div>` : ""}
      ${d.nota ? `<div style="background:#fff;border:1px solid ${COR.borda};border-left:4px solid ${COR.faixa};border-radius:10px;padding:12px 18px;margin-bottom:14px">
        ${d.nota.split("\n").map((t) => (t ? `<div style="padding:2px 0;font-weight:500">${esc(t)}</div>` : `<div style="height:8px"></div>`)).join("")}
      </div>` : ""}
    </div>
    <div style="padding:0 30px 18px;text-align:right;font-size:12.5px;color:${COR.texto2}">Brascof · internal use</div>`;
  return caixa;
}

async function gerarCanvas(d) {
  if (!d.grupos.length) throw new Error("The list is empty: add at least one client.");
  const capturar = await carregarScript(...HTML2CANVAS);
  const caixa = montarImagem(d);
  document.body.appendChild(caixa);
  try {
    await Promise.all([...caixa.querySelectorAll("img")].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = i.onerror = ok; }))));
    await document.fonts?.ready;
    return await capturar(caixa, { scale: 2, backgroundColor: COR.fundo, logging: false, useCORS: true });
  } finally {
    caixa.remove();
  }
}

function baixar(href, nome) {
  const a = document.createElement("a");
  a.href = href;
  a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
}
