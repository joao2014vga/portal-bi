// Modo demonstração: mesma interface da API do Supabase, com dados fictícios
// guardados no navegador. Serve para conhecer o portal antes de configurar.
import { storage } from "./ui.js";

const CHAVE = "portalbi_demo_v1";
const CHAVE_MODELO = "portalbi_demo_modelo";
const h = (horas) => new Date(Date.now() - horas * 36e5).toISOString();
const dias = (d) => new Date(Date.now() + d * 864e5).toISOString();

function seed() {
  return {
    seq: 100,
    sessao: null,
    usuarios: [
      { id: "u1", nome: "João Otavio Souza", email: "admin@demo.com", senha: "demo1234", is_admin: true, gerencia_arquivos: false, ativo: true, confirmado: true, ultimo_acesso: h(1), created_at: h(900) },
      { id: "u2", nome: "Mariana Costa", email: "mariana@demo.com", senha: "demo1234", is_admin: false, gerencia_arquivos: false, ativo: true, confirmado: true, ultimo_acesso: h(20), created_at: h(700) },
      { id: "u3", nome: "Rafael Lima", email: "rafael@demo.com", senha: "demo1234", is_admin: false, gerencia_arquivos: false, ativo: true, confirmado: false, ultimo_acesso: null, created_at: h(30) },
    ],
    categorias: [
      { id: 1, nome: "Comercial", ordem: 1 },
      { id: 2, nome: "Financeiro", ordem: 2 },
      { id: 3, nome: "Operações", ordem: 3 },
      { id: 4, nome: "Position", ordem: 0 },
    ],
    dashboards: [
      { id: 11, categoria_id: 1, titulo: "Vendas Diárias", descricao: "Faturamento por vendedor, região e mix de produtos, comparado à meta do mês.", link: "demo:vendas", nota: null, nota_tipo: "info", atualizado_em: h(3), frequencia: "diaria", ativo: true, ordem: 1 },
      { id: 12, categoria_id: 1, titulo: "Carteira de Clientes", descricao: "Positivação, clientes inativos e curva ABC da carteira.", link: "demo:carteira", nota: "Nova visão de churn disponível na página 3.", nota_tipo: "info", atualizado_em: h(30), frequencia: "diaria", ativo: true, ordem: 2 },
      { id: 21, categoria_id: 2, titulo: "Fluxo de Caixa", descricao: "Entradas e saídas realizadas e projetadas para os próximos 90 dias.", link: "demo:caixa", nota: "Dados de setembro em fechamento contábil — valores podem mudar.", nota_tipo: "alerta", atualizado_em: h(5), frequencia: "diaria", ativo: true, ordem: 1 },
      { id: 22, categoria_id: 2, titulo: "DRE Gerencial", descricao: "Resultado mensal por centro de custo.", link: "demo:dre", nota: null, nota_tipo: "info", atualizado_em: h(24 * 12), frequencia: "mensal", ativo: true, ordem: 2 },
      { id: 31, categoria_id: 3, titulo: "Estoque e Giro", descricao: "Posição de estoque por armazém, cobertura em dias e itens parados.", link: "demo:estoque", nota: null, nota_tipo: "info", atualizado_em: h(0.5), frequencia: "horaria", ativo: true, ordem: 1 },
      { id: 41, categoria_id: 4, titulo: "Position Overview", descricao: "Net position by term month and change vs the previous position.", link: "portal:position-overview", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "diaria", ativo: true, ordem: 1 },
      { id: 42, categoria_id: 4, titulo: "Physical Position", descricao: "Physical position by month and running balance by quality.", link: "portal:position-physical", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "diaria", ativo: true, ordem: 2 },
      { id: 43, categoria_id: 4, titulo: "Open Contracts", descricao: "Open purchases, export and domestic sales, and inventory, contract by contract.", link: "portal:position-contracts", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "diaria", ativo: true, ordem: 3 },
      { id: 44, categoria_id: 4, titulo: "Export Sales", descricao: "Shipped volume, revenue and sale diff, crop over crop, by client and quality.", link: "portal:position-sales", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "diaria", ativo: true, ordem: 4 },
      { id: 45, categoria_id: 4, titulo: "Purchases", descricao: "Purchased volume, value and purchase diff, crop over crop, by supplier and quality.", link: "portal:position-purchases", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "diaria", ativo: true, ordem: 5 },
      { id: 46, categoria_id: 4, titulo: "Dashboard Commercial", descricao: "Export sales: contracts, bags, average diffs, bags per client and what is left to ship.", link: "portal:position-commercial", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "diaria", ativo: true, ordem: 7 },
      { id: 32, categoria_id: 3, titulo: "Logística de Entregas", descricao: "OTIF, prazo médio e ocorrências por transportadora.", link: "demo:logistica", nota: null, nota_tipo: "info", atualizado_em: null, frequencia: "semanal", ativo: true, ordem: 2 },
    ],
    acessos: [
      ["u2", 11], ["u2", 12], ["u2", 31], ["u2", 41], ["u2", 42], ["u2", 44],
      ["u3", 21], ["u3", 22],
    ],
    avisos: [
      { id: 1, tipo: "banner", nivel: "alerta", titulo: "Manutenção programada", conteudo: "Sábado, das 20h às 23h, os relatórios podem ficar indisponíveis.", imagem_url: null, link: null, inicio: h(2), fim: dias(5), ativo: true },
      { id: 2, tipo: "mural", nivel: "info", titulo: "Novo painel de Estoque e Giro", conteudo: "Agora com atualização a cada hora e alerta de itens parados há mais de 60 dias.", imagem_url: null, link: null, inicio: h(26), fim: null, ativo: true },
      { id: 3, tipo: "mural", nivel: "info", titulo: "Treinamento de Power BI", conteudo: "Inscrições abertas para a turma de novembro. Fale com a equipe de BI.", imagem_url: null, link: null, inicio: h(72), fim: dias(20), ativo: true },
      { id: 4, tipo: "mural", nivel: "critico", titulo: "Fechamento de outubro", conteudo: "Os números de outubro só serão oficiais após o dia 5.", imagem_url: null, link: null, inicio: h(120), fim: null, ativo: true },
    ],
  };
}

export function criarDemo() {
  let db;
  try { db = JSON.parse(storage.get(CHAVE)) ?? seed(); } catch { db = seed(); }
  const salvar = () => storage.set(CHAVE, JSON.stringify(db));
  const ouvintes = [];
  const ouvintesNotif = [];
  const espera = () => new Promise((r) => setTimeout(r, 150));
  const eu = () => db.usuarios.find((u) => u.id === db.sessao);
  const exigeAdmin = () => { if (!eu()?.is_admin) throw new Error("Acesso negado"); };
  const exigeArquivos = () => { if (!eu()?.is_admin && !eu()?.gerencia_arquivos) throw new Error("Acesso negado"); };
  const semSenha = ({ senha, ...u }) => u;
  const novoId = () => ++db.seq;
  const vigente = (a) => a.ativo && new Date(a.inicio) <= new Date() && (!a.fim || new Date(a.fim) > new Date());

  return {
    demo: true,
    reset() { db = seed(); salvar(); },

    async sessao() { return db.sessao ? { user: { id: db.sessao, user_metadata: { trocar_senha: !!eu()?.trocar_senha } } } : null; },
    onAuth(cb) { ouvintes.push(cb); },
    async entrar(email, senha) {
      await espera();
      const u = db.usuarios.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      if (!u || u.senha !== senha) throw new Error("Incorrect e-mail or password.");
      if (!u.ativo) throw new Error("Inactive user. Please contact the administrator.");
      db.sessao = u.id; u.ultimo_acesso = new Date().toISOString(); salvar();
      ouvintes.forEach((cb) => cb("SIGNED_IN"));
    },
    async sair() { db.sessao = null; salvar(); ouvintes.forEach((cb) => cb("SIGNED_OUT")); },
    async recuperarSenha() { await espera(); },
    async definirSenha(senha) {
      if (senha.length < 8) throw new Error("The password must be at least 8 characters long.");
      if (senha === eu().senha) throw new Error("The new password must be different from the previous one.");
      Object.assign(eu(), { senha, trocar_senha: false }); salvar();
    },
    async meuPerfil() { const u = eu(); return u ? semSenha(u) : null; },

    async categorias() { return structuredClone(db.categorias).sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome)); },
    async salvarCategoria(c) {
      exigeAdmin();
      if (db.categorias.some((x) => x.nome.toLowerCase() === c.nome.toLowerCase() && x.id !== c.id)) throw new Error("Já existe um registro com esse nome.");
      if (c.id) Object.assign(db.categorias.find((x) => x.id === c.id), c);
      else db.categorias.push({ ...c, id: novoId() });
      salvar();
    },
    async excluirCategoria(id) {
      exigeAdmin();
      db.categorias = db.categorias.filter((x) => x.id !== id);
      db.dashboards.forEach((d) => { if (d.categoria_id === id) d.categoria_id = null; });
      salvar();
    },

    async dashboards() {
      const me = eu();
      const lista = me.is_admin
        ? db.dashboards
        : db.dashboards.filter((d) => d.ativo && db.acessos.some(([u, x]) => u === me.id && x === d.id));
      return structuredClone(lista).sort((a, b) => a.ordem - b.ordem || a.titulo.localeCompare(b.titulo));
    },
    async dashboard(id) { return (await this.dashboards()).find((d) => d.id === Number(id)) ?? null; },
    async salvarDashboard(d, usuarios) {
      exigeAdmin();
      let id = d.id;
      if (id) Object.assign(db.dashboards.find((x) => x.id === id), d);
      else { id = novoId(); db.dashboards.push({ ...d, id }); }
      if (usuarios) {
        db.acessos = db.acessos.filter(([, x]) => x !== id).concat(usuarios.map((u) => [u, id]));
      }
      salvar();
    },
    async excluirDashboard(id) {
      exigeAdmin();
      db.dashboards = db.dashboards.filter((x) => x.id !== id);
      db.acessos = db.acessos.filter(([, x]) => x !== id);
      salvar();
    },
    async marcarAtualizado(id) {
      exigeAdmin();
      const d = db.dashboards.find((x) => x.id === id);
      d.atualizado_em = new Date().toISOString();
      const n = { id: novoId(), dashboard_id: id, titulo: `${d.titulo} was updated`, mensagem: null, autor: db.sessao, created_at: d.atualizado_em };
      (db.notificacoes ??= []).unshift(n);
      salvar();
      ouvintesNotif.forEach((cb) => cb(structuredClone(n)));
    },
    async acessosDoDashboard(id) { return db.acessos.filter(([, x]) => x === id).map(([u]) => u); },
    async acessosDoUsuario(uid) { return db.acessos.filter(([u]) => u === uid).map(([, x]) => x); },
    async contagemAcessos() { return db.acessos.map(([u, d]) => ({ user_id: u, dashboard_id: d })); },

    async usuarios() { exigeArquivos(); return db.usuarios.map(semSenha).sort((a, b) => a.nome.localeCompare(b.nome)); },
    async criarUsuario({ nome, email, senha, is_admin, dashboards }) {
      exigeAdmin(); await espera();
      if (db.usuarios.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw new Error("This e-mail already has access to the portal");
      if ((senha ?? "").length < 8) throw new Error("The temporary password must be at least 8 characters long");
      const id = "u" + novoId();
      db.usuarios.push({ id, nome, email, senha, is_admin: !!is_admin, ativo: true, confirmado: true, trocar_senha: true, ultimo_acesso: null, created_at: new Date().toISOString() });
      db.acessos.push(...(dashboards ?? []).map((d) => [id, d]));
      salvar();
      return { ok: true, id, ja_tinha_login: false };
    },
    async salvarUsuario({ id, nome, is_admin, ativo, gerencia_arquivos }, dashboards) {
      exigeAdmin();
      Object.assign(db.usuarios.find((u) => u.id === id), { nome, is_admin, ativo, gerencia_arquivos: !!gerencia_arquivos });
      if (dashboards) db.acessos = db.acessos.filter(([u]) => u !== id).concat(dashboards.map((d) => [id, d]));
      salvar();
    },
    async redefinirSenha(id, senha) {
      exigeAdmin(); await espera();
      if ((senha ?? "").length < 8) throw new Error("The temporary password must be at least 8 characters long");
      Object.assign(db.usuarios.find((x) => x.id === id), { senha, trocar_senha: true }); salvar();
      return { ok: true };
    },
    async excluirUsuario(id) {
      exigeAdmin();
      if (id === db.sessao) throw new Error("You cannot delete your own user");
      db.usuarios = db.usuarios.filter((u) => u.id !== id);
      db.acessos = db.acessos.filter(([u]) => u !== id);
      salvar();
    },

    async avisos() {
      const lista = eu().is_admin ? db.avisos : db.avisos.filter(vigente);
      return structuredClone(lista).sort((a, b) => b.inicio.localeCompare(a.inicio));
    },
    async salvarAviso(a) {
      exigeAdmin();
      if (a.id) Object.assign(db.avisos.find((x) => x.id === a.id), a);
      else db.avisos.push({ ...a, id: novoId() });
      salvar();
    },
    async excluirAviso(id) { exigeAdmin(); db.avisos = db.avisos.filter((x) => x.id !== id); salvar(); },

    // arquivos ficam no próprio navegador (data URL), então só servem arquivos pequenos
    async arquivos() {
      const me = eu();
      const lista = (db.arquivos ??= []).filter((a) => me.is_admin || me.gerencia_arquivos || (a.ativo && (db.arqAcessos ?? []).some(([u, x]) => u === me.id && x === a.id)));
      return structuredClone(lista).sort((a, b) => a.ordem - b.ordem || a.titulo.localeCompare(b.titulo));
    },
    async enviarArquivo(file) {
      if (file.size > 1024 * 1024) throw new Error("Demo mode only stores files up to 1 MB.");
      const caminho = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(new Error("Unable to read the file"));
        r.readAsDataURL(file);
      });
      return { caminho, nome_arquivo: file.name, tamanho: file.size };
    },
    async salvarArquivo(a, usuarios) {
      exigeArquivos();
      db.arquivos ??= []; db.arqAcessos ??= [];
      let id = a.id;
      const antes = id ? db.arquivos.find((x) => x.id === id) : null;
      if (antes) Object.assign(antes, a);
      else { id = novoId(); db.arquivos.push({ ...a, id, atualizado_em: a.atualizado_em ?? new Date().toISOString() }); }
      if (usuarios) db.arqAcessos = db.arqAcessos.filter(([, x]) => x !== id).concat(usuarios.map((u) => [u, id]));
      if (!antes || a.atualizado_em) {
        const arq = db.arquivos.find((x) => x.id === id);
        const n = { id: novoId(), arquivo_id: id, dashboard_id: null, titulo: `${arq.titulo} ${antes ? "was updated" : "is available"}`, mensagem: "File ready to download", autor: db.sessao, created_at: new Date().toISOString() };
        (db.notificacoes ??= []).unshift(n);
        ouvintesNotif.forEach((cb) => cb(structuredClone(n)));
      }
      salvar();
    },
    async removerObjetoArquivo() {},
    async excluirArquivo(a) { exigeArquivos(); db.arquivos = db.arquivos.filter((x) => x.id !== a.id); db.arqAcessos = (db.arqAcessos ?? []).filter(([, x]) => x !== a.id); salvar(); },
    async acessosDoArquivo(id) { return (db.arqAcessos ?? []).filter(([, x]) => x === id).map(([u]) => u); },
    async contagemAcessosArquivos() { return (db.arqAcessos ?? []).map(([u, a]) => ({ user_id: u, arquivo_id: a })); },
    async linkDownload(a) { return a.caminho; },

    // Position: guardado no navegador (só para demonstração)
    // (a sincronização com o Digisul não existe na demonstração: só há a fonte "planilha")
    async positionUltima(fonte = "planilha") {
      const c = db.position?.cargas ?? [];
      return fonte === "planilha" && c.length ? structuredClone(c[c.length - 1]) : null;
    },
    async positionHistorico(fonte = "planilha") {
      if (fonte !== "planilha") return [];
      const porDia = new Map((db.position?.cargas ?? []).map((c) => [c.data_ref, { id: c.id, data_ref: c.data_ref, kpis: c.resumo.kpis }]));
      return structuredClone([...porDia.values()]);
    },
    async positionDetalhe(tipos) {
      const d = db.position?.detalhe ?? {};
      return structuredClone(Object.fromEntries(tipos.filter((t) => d[t]).map((t) => [t, d[t]])));
    },
    async positionPegadaAnterior(fonte, data_ref = null) {
      const c = (db.position?.cargas ?? []).filter((x) => (!data_ref || x.data_ref < data_ref) && x.resumo.pegada);
      const u = c[c.length - 1];
      return u ? structuredClone({ data_ref: u.data_ref, created_at: u.created_at, pegada: u.resumo.pegada }) : null;
    },
    async positionFonte() { return "planilha"; },
    async definirFontePosition() { throw new Error("Not available in demo mode."); },
    // modelo (fórmulas + futuros) numa chave própria do navegador: é grande para ficar junto do resto
    async positionModeloInfo() {
      const m = JSON.parse(storage.get(CHAVE_MODELO) ?? "null");
      return m ? { atualizado_em: m.atualizado_em, nome_arquivo: m.nome_arquivo, enviado_por: m.enviado_por, futuros: m.modelo.futuros?.length ?? 0 } : null;
    },
    async positionModelo() { return JSON.parse(storage.get(CHAVE_MODELO) ?? "null")?.modelo ?? null; },
    async positionFuturos() { return JSON.parse(storage.get(CHAVE_MODELO) ?? "null")?.modelo?.futuros ?? null; },
    async salvarPositionModelo(modelo, nome_arquivo) {
      exigeArquivos();
      storage.set(CHAVE_MODELO, JSON.stringify({ modelo, nome_arquivo, enviado_por: eu().nome, atualizado_em: new Date().toISOString() }));
    },
    async sincronizarPosition() { throw new Error("The Digisul update is not available in demo mode."); },
    async publicarPosition({ data_ref, nome_arquivo, resumo, detalhes, alerta = null }) {
      exigeArquivos();
      db.position ??= { cargas: [], detalhe: {} };
      const agora = new Date().toISOString();
      db.position.cargas.push({ id: novoId(), data_ref, nome_arquivo, enviado_por: eu().nome.split(" ")[0], resumo, created_at: agora });
      db.position.cargas.sort((a, b) => a.data_ref.localeCompare(b.data_ref) || a.id - b.id);
      db.position.detalhe = detalhes;
      db.dashboards.filter((d) => d.link.startsWith("portal:position-")).forEach((d) => { d.atualizado_em = agora; });
      const contratos = db.dashboards.find((d) => d.link === "portal:position-contracts");
      if (alerta && contratos) {
        const n = { id: novoId(), dashboard_id: contratos.id, arquivo_id: null, titulo: "Fixation alert", mensagem: alerta, autor: db.sessao, created_at: agora };
        (db.notificacoes ??= []).unshift(n);
        ouvintesNotif.forEach((cb) => cb(structuredClone(n)));
      }
      salvar();
    },

    // certificados: a base só vem da sincronização com o Digisul (sem dados no modo demonstração)
    async certBase() { return null; },
    async certAjustes(certificado) { return structuredClone((db.certAjustes ?? []).filter((a) => a.certificado === certificado)); },
    async salvarCertAjuste(ajustes) {
      exigeArquivos();
      for (const { certificado, tipo, contrato, acao = "incluir", sacas = null, obs = null } of [].concat(ajustes)) {
        db.certAjustes = (db.certAjustes ?? []).filter((a) => !(a.certificado === certificado && a.tipo === tipo && a.contrato === contrato));
        db.certAjustes.push({ id: novoId(), certificado, tipo, contrato, acao, sacas, obs, autor: eu().nome, created_at: new Date().toISOString() });
      }
      salvar();
    },
    async removerCertAjuste(id) { exigeArquivos(); db.certAjustes = (db.certAjustes ?? []).filter((a) => a.id !== id); salvar(); },
    async certHistorico(certificado) { return structuredClone((db.certHistorico ?? []).filter((h) => h.certificado === certificado)); },
    async certVinculos(certificado) { return structuredClone((db.certVinculos ?? []).filter((v) => v.certificado === certificado)); },
    async salvarCertVinculos(certificado, venda, linhas) {
      exigeArquivos();
      db.certVinculos = [...(db.certVinculos ?? []).filter((v) => !(v.certificado === certificado && v.venda === venda)),
        ...linhas.filter((l) => l.sacas > 0).map((l) => ({ id: novoId(), certificado, venda, ...l, autor: eu().nome, created_at: new Date().toISOString() }))];
      salvar();
    },
    async salvarCertCompra({ id, ...linha }) {
      exigeArquivos();
      db.certHistorico ??= [];
      const h = id && db.certHistorico.find((x) => x.id === id);
      if (h) Object.assign(h, linha, { ordem: h.ordem, alterado_por: eu().nome, updated_at: new Date().toISOString() });
      else db.certHistorico.push({ id: novoId(), ...linha, origem: "manual", vinculos: [], importado_por: eu().nome, created_at: new Date().toISOString() });
      salvar();
    },
    async desvincularCertHistorico(id, campos) {
      exigeArquivos();
      const h = (db.certHistorico ?? []).find((x) => x.id === id);
      if (h) Object.assign(h, campos, { alterado_por: eu().nome, updated_at: new Date().toISOString() });
      salvar();
    },
    async removerCertCompra(id) {
      exigeArquivos();
      db.certHistorico = (db.certHistorico ?? []).filter((h) => h.id !== id);
      db.certVinculos = (db.certVinculos ?? []).filter((v) => v.historico_id !== id);
      salvar();
    },
    async importarCertHistorico(certificado, linhas) {
      exigeArquivos();
      db.certHistorico = [...(db.certHistorico ?? []).filter((h) => h.certificado !== certificado || h.origem === "manual"),
        ...linhas.map((l) => ({ id: novoId(), certificado, origem: "planilha", ...l, importado_por: eu().nome, created_at: new Date().toISOString() }))];
      salvar();
      return linhas.length;
    },

    async notificacoes() {
      const visiveis = (await this.dashboards()).map((d) => d.id);
      const arqs = (await this.arquivos()).map((a) => a.id);
      return structuredClone((db.notificacoes ?? []).filter((n) => n.arquivo_id ? arqs.includes(n.arquivo_id) : visiveis.includes(n.dashboard_id)).slice(0, 30));
    },
    async marcarNotificacoesVistas() {
      const agora = new Date().toISOString();
      eu().notif_vistas_em = agora; salvar();
      return agora;
    },
    ouvirNotificacoes(cb) { ouvintesNotif.length = 0; ouvintesNotif.push(cb); },
    pararNotificacoes() { ouvintesNotif.length = 0; },

    async enviarImagem(file) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error("Falha ao ler a imagem"));
        r.readAsDataURL(file);
      });
    },
  };
}
