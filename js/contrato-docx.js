// Contrato de compra e venda de café FUTURO: textos padrão e preenchimento do modelo .docx.
//
// O modelo (bi_ctr_modelos, seção 36) é o contrato BRC-0448/26 com os nove parágrafos que
// mudam de um contrato para outro trocados por marcadores — um run só, com a fonte do
// parágrafo: {{CABECALHO}} {{VENDEDOR}} {{MERCADORIA}} {{NEGOCIO}} {{ENTREGA}} {{PRECO}}
// {{LOCAL_DATA}} {{ASSINA_NOME}} {{ASSINA_DOC}}. O resto (cláusulas, cabeçalho, logos,
// numeração) fica intacto.
//
// Os textos usam uma marcação simples, que vira formatação no Word:
//   **texto**  negrito          __texto__  negrito sublinhado (como no modelo)
//
// Os valores padrão saem do Digisul e das regras dos contratos já feitos; a tela mostra
// tudo para conferir e editar antes de gerar.

const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

// ----------------------------------------------------------------- formatação
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const brData = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
export const isoDeBr = (br) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(br ?? "").trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
export const dataExtenso = (iso) => (iso ? `${Number(iso.slice(8, 10))} de ${MESES[Number(iso.slice(5, 7)) - 1]} de ${iso.slice(0, 4)}` : "");
const fmt = (v, d = 0) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
export const reais = (v) => `R$ ${fmt(v, 2)}`;
export const sacasTxt = (v) => fmt(v, Number.isInteger(Number(v)) ? 0 : 2);
// "2027/2028" → "27/28"
export const safraCurta = (s) => { const m = /(\d{2,4})\s*\/\s*(\d{2,4})/.exec(String(s ?? "")); return m ? `${m[1].slice(-2)}/${m[2].slice(-2)}` : String(s ?? ""); };
const hojeIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const fimDoMes = (iso) => { const [y, m] = iso.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

// "123.456.789-00" | "12.345.678/0001-90" a partir dos dígitos (o que não tiver 11/14 fica como veio)
export function formatarDoc(doc) {
  const d = String(doc ?? "").replace(/\D/g, "");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return String(doc ?? "").trim();
}
export const ehPessoaJuridica = (doc) => String(doc ?? "").replace(/\D/g, "").length === 14;

// ----------------------------------------------------------------- regras do café
// catação: o % de "CONSUMO" na peneira do Digisul ("CONSUMO 800DEF-15.00%,13/16-65.00%");
// sem ela, o % de quebra do contrato
export function catacao(c) {
  const m = /CONSUMO[^,%]*?-?\s*([\d.,]+)\s*%/i.exec(c?.peneira ?? "");
  const v = m ? Number(m[1].replace(",", ".")) : c?.quebra;
  return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100;
}
// como nos contratos feitos: até 15% de catação é Fine Cup; acima, Good Cup
export const qualidade = (cat) => (cat != null && cat <= 15 ? "Fine Cup" : "Good Cup");
// bebida do Digisul → texto do contrato; `dura` decide o fecho longo da cláusula
export function bebida(b) {
  const s = String(b ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!s || s === "DURO" || s === "DURA") return { texto: "duro", dura: true };
  const riadas = /(\d+)\s*RIADA/.exec(s), rio = /(\d+)\s*RIO\b/.exec(s);
  if (/^D\b|^DURO/.test(s) && (riadas || rio)) {
    const partes = [riadas && `${riadas[1]} Riadas`, rio && `${rio[1]} Rio`].filter(Boolean);
    return { texto: `duro com no máximo ${partes.join(" e ")}`, dura: false };
  }
  if (s === "RIO") return { texto: "Rio", dura: false };
  return { texto: String(b).trim().toLowerCase(), dura: false };
}
// certificados do contrato: o EUDR não entra no texto (é rastreabilidade, não certificado)
export function certificados(cert) {
  return String(cert ?? "").split(/[,;/]/).map((x) => x.trim()).filter((x) => x && !/^EUDR$/i.test(x));
}
const juntar = (l) => (l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} e ${l[l.length - 1]}`);

const FECHO_DURA = "de forma regular, não se admitindo entrega de cafés chuvados, com umidade inferior a 10,5% nem superior a 12%, mal secos, barrentos, infestados ou com gostos estranhos tais como, mas não limitados, a gosto de terra, sujeira, fermento ou quaisquer outros sabores que venham a descaracterizar a uniformidade da Bebida Dura do Café Arábica.";
const FECHO_OUTRA = "de forma regular, não se admitindo entrega de cafés chuvados, com umidade inferior a 10,5% nem superior a 12%.";

// descrição do café, logo depois de "do tipo Café arábica,"
export function descricaoPadrao(c) {
  const cat = catacao(c);
  const beb = bebida(c.bebida);
  const certs = certificados(c.certificador);
  const catTxt = cat ? ` com no máximo de ${fmt(cat, Number.isInteger(cat) ? 0 : 2)}% de catação` : "";
  return `**bica-corrida,** ${qualidade(cat)}${catTxt}, conforme a Classificação Oficial Brasileira ("COB"), `
    + `${certs.length ? "certificado " : ""}peneira da safra**, bebendo ${beb.texto}${beb.dura ? " **" : "**, "}`
    + `${beb.dura ? FECHO_DURA : FECHO_OUTRA}`
    + (certs.length ? ` Café com ${certs.length > 1 ? "certificados" : "certificado"} ${juntar(certs)}.` : "");
}

// qualificação do vendedor (o texto depois do nome) quando ele ainda não tem uma salva
export function qualificacaoPadrao({ documento, ie, cidade, uf } = {}) {
  const estado = { MG: "MINAS GERAIS", SP: "SÃO PAULO", ES: "ESPÍRITO SANTO", PR: "PARANÁ", BA: "BAHIA", GO: "GOIÁS", RO: "RONDÔNIA", RJ: "RIO DE JANEIRO" }[String(uf ?? "MG").toUpperCase()] ?? uf;
  const lugar = `Município de ${cidade || "[preencher]"}, Estado de ${estado || "MINAS GERAIS"}, Brasil;`;
  const ieTxt = ie ? `, Inscrição Estadual n° ${ie}` : "";
  return ehPessoaJuridica(documento)
    ? `pessoa jurídica, CNPJ n° ${formatarDoc(documento) || "[preencher]"}${ieTxt}, sediada no ${lugar}`
    : `brasileiro, PRODUTOR RURAL, CPF n° ${formatarDoc(documento) || "[preencher]"}${ieTxt} residente no ${lugar}`;
}

// Preço por saca sugerido: o do último documento; senão o do Digisul. A média do Digisul
// (Media_Reais) de produtor pessoa física é o preço do contrato sem 1%: conferido em 2026,
// o preço da planilha = média × 1,01 em 83 de 86 contratos de PF e = média nos 71 de PJ.
// A tela pede para conferir.
export const FATOR_PF = 1.01;
export function precoSugerido(c, controle, documento) {
  const salvo = controle?.dados?.preco;
  if (salvo) return Number(salvo);
  if (!(Number(c.media) > 1)) return null;
  const pj = ehPessoaJuridica(documento ?? c.fornecedor_documento);
  return Math.round(Number(c.media) * (pj ? 1 : FATOR_PF) * 100) / 100;
}
// contrato a fixar (preço simbólico de R$ 0,01/0,10 no Digisul)
export const aFixar = (c) => !(Number(c.media ?? c.media_final) > 1);

// inscrição estadual de MG com 13 dígitos como nos contratos: "001.250.718/1109"
export function formatarIE(ie) {
  const d = String(ie ?? "").replace(/\D/g, "");
  return d.length === 13 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{4})/, "$1.$2.$3/$4") : String(ie ?? "").trim();
}

export function precoTexto({ preco, sacas }) {
  if (!(Number(preco) > 0)) return "compra negociada em diferencial de [preencher] que deverão ser pagos pela Compradora.";
  const total = Math.round(Number(preco) * Number(sacas) * 100) / 100;
  return `o equivalente a **${reais(preco)}** por saca de 60 Kg, totalizando **${reais(total)}** que deverão ser pagos pela Compradora.`;
}

// Campos do formulário a partir do contrato do Digisul, do vendedor salvo e do último
// documento gerado (que tem prioridade: refazer o documento sai igual).
export function camposPadrao(c, vendedor, controle) {
  const salvo = controle?.dados ?? {};
  const venc = c.vencimento ?? c.prev_entrega;
  // vendedor sem cadastro no portal: CPF/CNPJ e inscrição do Digisul
  const documento = formatarDoc(vendedor?.documento || c.fornecedor_documento || "");
  const ie = vendedor?.ie || formatarIE(c.fornecedor_ie);
  const preco = precoSugerido(c, controle, documento);
  const sacas = c.sacas ?? c.sacas_total;
  const base = {
    contrato: c.contrato,
    vendedor_nome: c.fornecedor ?? "",
    qualificacao: vendedor?.qualificacao || qualificacaoPadrao({ documento, ie, cidade: vendedor?.cidade ?? c.cidade, uf: vendedor?.uf }),
    documento,
    sacas,
    safra: safraCurta(c.safra),
    descricao: descricaoPadrao(c),
    data_negocio: brData(c.emissao),
    entrega_ini: venc ? brData(`${venc.slice(0, 8)}01`) : "",
    entrega_fim: venc ? brData(venc) : "",
    entrega_local: "na cidade do vendedor",
    preco,
    preco_texto: precoTexto({ preco: aFixar(c) && !salvo.preco ? null : preco, sacas }),
    data_assinatura: brData(hojeIso()),
    email: controle?.email ?? vendedor?.email ?? "",
  };
  return { ...base, ...salvo, contrato: c.contrato };
}

// ----------------------------------------------------------------- docx
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "a **b** __c__" → [{ t: "a ", b: false, u: false }, { t: "b", b: true }, { t: "c", b: true, u: true }]
export function segmentos(markup) {
  const out = [];
  const re = /\*\*([\s\S]*?)\*\*|__([\s\S]*?)__/g;
  let i = 0, m;
  while ((m = re.exec(markup))) {
    if (m.index > i) out.push({ t: markup.slice(i, m.index), b: false, u: false });
    out.push(m[1] != null ? { t: m[1], b: true, u: false } : { t: m[2], b: true, u: true });
    i = re.lastIndex;
  }
  if (i < markup.length) out.push({ t: markup.slice(i), b: false, u: false });
  return out.filter((s) => s.t);
}
export const semMarcacao = (markup) => segmentos(markup).map((s) => s.t).join("");

// rPr do marcador + negrito/sublinhado, na ordem que o Word espera
function rPr(base, { b, u }) {
  let r = base || "<w:rPr></w:rPr>";
  if (b) r = /<w:rFonts[^>]*\/>/.test(r) ? r.replace(/(<w:rFonts[^>]*\/>)/, "$1<w:b/><w:bCs/>") : r.replace("<w:rPr>", "<w:rPr><w:b/><w:bCs/>");
  if (u) r = /<w:lang /.test(r) ? r.replace(/<w:lang /, '<w:u w:val="single"/><w:lang ') : r.replace("</w:rPr>", '<w:u w:val="single"/></w:rPr>');
  return r === "<w:rPr></w:rPr>" ? "" : r;
}
const runs = (base, markup) => segmentos(markup)
  .map((s) => `<w:r>${rPr(base, s)}<w:t xml:space="preserve">${escXml(s.t)}</w:t></w:r>`).join("");

// os nove parágrafos que mudam
export function paragrafos(f) {
  const c = f.contrato;
  return {
    CABECALHO: `Contrato(s) número(s): **${c}**`,
    VENDEDOR: `**Vendedor(a), ${f.vendedor_nome},** ${f.qualificacao}`,
    MERCADORIA: `Contrato Nº **${c}**, referente à **${sacasTxt(f.sacas)} sacas** de 60 Kg de café cru, safra **${f.safra}** do tipo Café **arábica,** ${f.descricao}`,
    NEGOCIO: `Este Contrato ratifica e formaliza os termos do negócio já realizado entre as partes conforme confirmação de negócio enviada por e-mail em __${f.data_negocio}__.`,
    ENTREGA: `Referente ao Contrato **${c}** entre os dias ${f.entrega_ini} e ${f.entrega_fim}, ${f.entrega_local}.`,
    PRECO: ` Relativamente à compra de café de n° __${c}__ da safra **${f.safra}**, ${f.preco_texto}`,
    LOCAL_DATA: `Varginha, Minas Gerais ${dataExtenso(isoDeBr(f.data_assinatura))}`,
    ASSINA_NOME: `**${f.vendedor_nome}**`,
    ASSINA_DOC: `**${f.documento}**`,
  };
}

// o que falta ou está estranho antes de gerar (a tela mostra e não deixa gerar com erro)
export function conferir(f) {
  const erros = [];
  if (!String(f.vendedor_nome ?? "").trim()) erros.push("Seller name is empty.");
  if (/\[preencher\]/i.test(f.qualificacao ?? "")) erros.push("Fill in the seller's CPF/CNPJ and town in the seller line.");
  if (!String(f.documento ?? "").replace(/\D/g, "")) erros.push("Seller CPF/CNPJ is empty.");
  if (!(Number(f.sacas) > 0)) erros.push("Bags must be greater than zero.");
  for (const [k, rot] of [["data_negocio", "Deal date"], ["entrega_ini", "Delivery from"], ["entrega_fim", "Delivery to"], ["data_assinatura", "Signing date"]]) {
    if (!isoDeBr(f[k])) erros.push(`${rot} must be a date like 28/07/2026.`);
  }
  if (/\[preencher\]/i.test(f.preco_texto ?? "")) erros.push("Fill in the price clause (price per bag or the differential).");
  const abertos = (s) => ((String(s ?? "").match(/\*\*/g) ?? []).length % 2) || ((String(s ?? "").match(/__/g) ?? []).length % 2);
  if (["descricao", "preco_texto", "qualificacao"].some((k) => abertos(f[k]))) erros.push("A ** or __ mark is not closed.");
  return erros;
}

let jszip = null;
function carregarJsZip() {
  jszip ??= new Promise((ok, falha) => {
    if (window.JSZip) return ok(window.JSZip);
    const s = document.createElement("script");
    s.src = JSZIP_URL;
    s.onload = () => ok(window.JSZip);
    s.onerror = () => { jszip = null; s.remove(); falha(new Error("Unable to load the Word generator. Check your connection.")); };
    document.head.appendChild(s);
  });
  return jszip;
}

const base64ParaBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
export async function bytesParaBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Preenche o modelo (base64) e devolve o Blob do .docx. Falta marcador no modelo = erro.
export async function gerarDocx(modeloBase64, campos) {
  const JSZip = await carregarJsZip();
  const zip = await JSZip.loadAsync(base64ParaBytes(modeloBase64));
  let xml = await zip.file("word/document.xml").async("string");
  for (const [chave, markup] of Object.entries(paragrafos(campos))) {
    const re = new RegExp(`<w:r>(<w:rPr>(?:(?!</w:rPr>)[\\s\\S])*</w:rPr>)?<w:t xml:space="preserve">\\{\\{${chave}\\}\\}</w:t></w:r>`);
    const m = re.exec(xml);
    if (!m) throw new Error(`The contract template has no {{${chave}}} mark. Upload the template again.`);
    xml = xml.slice(0, m.index) + runs(m[1] ?? "", markup) + xml.slice(m.index + m[0].length);
  }
  zip.file("word/document.xml", xml);
  // o título do arquivo (Arquivo → Propriedades) passa a ser o número do contrato
  const core = zip.file("docProps/core.xml");
  if (core) {
    const c = await core.async("string");
    zip.file("docProps/core.xml", c.replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${escXml(campos.contrato)}</dc:title>`));
  }
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", compression: "DEFLATE" });
}

// nome do arquivo como na pasta de contratos: "BRC-0448.26.docx"
export const nomeArquivo = (contrato, ext = "docx") => `${String(contrato).replace("/", ".")}.${ext}`;
