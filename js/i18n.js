// Idioma do portal. O código e as telas são escritos em inglês; com
// CONFIG.IDIOMA = "pt" este módulo traduz o que aparece na tela usando o
// dicionário abaixo (e `t()` para os textos desenhados em gráficos).
// Para voltar ao inglês basta CONFIG.IDIOMA = "en" — nada mais muda.
//
// Como a tradução da tela funciona: um observador percorre os textos e os
// atributos placeholder/title/aria-label que entram na página e troca:
//   1. textos exatos do dicionário ("Sign in" → "Entrar");
//   2. frases com números, usando {n} no dicionário ("{n} lots" → "{n} lotes");
//   3. tempo relativo, usando {t} ("Refreshed {t}" → "Atualizado {t}");
//   4. trechos separados por " · ", cada um por conta própria;
//   5. alguns casos especiais com nomes/e-mails (ESPECIAIS).
// O que não está no dicionário fica como está (nomes, contratos, dados).
import { CONFIG } from "./config.js";

export const IDIOMA = CONFIG.IDIOMA === "pt" ? "pt" : "en";
export const LOCALE = IDIOMA === "pt" ? "pt-BR" : "en-US";

const PT = {
  // ---------------------------------------------------------------- geral / topo
  "BI Portal": "Portal BI", "Home": "Início", "Files": "Arquivos", "Announcements": "Avisos", "Administration": "Administração",
  "Notifications": "Notificações", "No notifications yet.": "Nenhuma notificação ainda.", "Sign out": "Sair", "Back": "Voltar",
  "Full screen": "Tela cheia", "Open in new tab": "Abrir em nova aba", "Close": "Fechar", "Cancel": "Cancelar", "Save": "Salvar",
  "Delete": "Excluir", "Edit": "Editar", "Now": "Agora", "Copy": "Copiar", "Generate": "Gerar", "Upload": "Enviar",
  "Select all": "Selecionar todos", "Clear": "Limpar", "Filter…": "Filtrar…", "{n} of {n} selected": "{n} de {n} selecionados",
  "Dismiss announcement": "Fechar aviso", "Learn more": "Saiba mais", "View all": "Ver todos", "Total": "Total",
  "Demo mode": "Modo demonstração", "Demo mode — sample data stored in this browser only.": "Modo demonstração — dados de exemplo salvos só neste navegador.",
  "Reset data": "Restaurar dados", "Unable to load this page": "Não foi possível carregar esta página",
  "Admin:": "Admin:", "· User:": "· Usuário:", "Password:": "Senha:", "Position": "Posição",
  "Please enable JavaScript to use the portal.": "Ative o JavaScript para usar o portal.",
  "Good morning": "Bom dia", "Good afternoon": "Boa tarde", "Good evening": "Boa noite",

  // ---------------------------------------------------------------- login e senha
  "Corporate Reporting Portal": "Portal Corporativo de Relatórios",
  "Centralized access to management reports, key performance indicators and corporate communications.":
    "Acesso centralizado a relatórios gerenciais, indicadores de desempenho e comunicados corporativos.",
  "Restricted access — authorized personnel only.": "Acesso restrito — somente pessoas autorizadas.",
  "Sign in": "Entrar", "Use the e-mail address registered by the BI team.": "Use o e-mail cadastrado pela equipe de BI.",
  "E-mail": "E-mail", "Password": "Senha", "Forgot your password?": "Esqueceu a senha?", "name@company.com": "nome@empresa.com",
  "Please enter your e-mail and password.": "Informe seu e-mail e senha.",
  "Please contact the portal administrator. They will set a temporary password for you, which you will be asked to change at your next sign-in.":
    "Fale com o administrador do portal. Ele vai definir uma senha provisória, que você deverá trocar no próximo acesso.",
  "Create a new password": "Crie uma nova senha", "Set your password to access the portal.": "Defina sua senha para acessar o portal.",
  "Choose a new password for your account.": "Escolha uma nova senha para sua conta.",
  "For security reasons, please replace your temporary password with a personal one before continuing.":
    "Por segurança, troque a senha provisória por uma senha pessoal antes de continuar.",
  "New password": "Nova senha", "Confirm password": "Confirmar senha", "Minimum of 8 characters.": "Mínimo de 8 caracteres.",
  "Save password": "Salvar senha", "Password set successfully.": "Senha definida com sucesso.",
  "The password must be at least 8 characters long.": "A senha precisa ter pelo menos 8 caracteres.",
  "The passwords do not match.": "As senhas não conferem.",
  "Incorrect e-mail or password.": "E-mail ou senha incorretos.",
  "Your invitation has not been accepted yet. Please check your e-mail.": "Seu convite ainda não foi aceito. Verifique seu e-mail.",
  "The new password must be different from the previous one.": "A nova senha precisa ser diferente da anterior.",
  "A record with this name already exists.": "Já existe um registro com esse nome.",
  "Too many attempts. Please wait a few minutes.": "Muitas tentativas. Aguarde alguns minutos.",
  "Unable to connect to the server.": "Não foi possível conectar ao servidor.",
  "This link has expired. Please request a new one from the administrator.": "Este link expirou. Peça um novo ao administrador.",
  "Profile not found. Please contact the administrator.": "Perfil não encontrado. Fale com o administrador.",
  "Your access has been deactivated. Please contact the administrator.": "Seu acesso foi desativado. Fale com o administrador.",

  // ---------------------------------------------------------------- início, relatórios, avisos
  "Search reports…": "Buscar relatórios…", "Search reports": "Buscar relatórios",
  "{n} reports available to you": "{n} relatórios disponíveis para você", "{n} report available to you": "{n} relatório disponível para você",
  "{n} overdue for refresh": "{n} com atualização atrasada",
  "No reports available yet": "Nenhum relatório disponível ainda", "No reports found": "Nenhum relatório encontrado",
  "Add the first report under Administration.": "Cadastre o primeiro relatório em Administração.",
  "Please ask the BI team to grant you access to the reports you need.": "Peça à equipe de BI acesso aos relatórios de que você precisa.",
  "Add report": "Adicionar relatório", "Other": "Outros", "Integrated system": "Sistema integrado", "New": "Novo", "Attention": "Atenção",
  "Refreshed {t}": "Atualizado {t}", "Refresh overdue": "Atualização atrasada", "Refresh date not provided": "Data de atualização não informada",
  "Hourly": "De hora em hora", "Daily": "Diária", "Weekly": "Semanal", "Monthly": "Mensal", "Manual": "Manual",
  "Communications from the BI team.": "Comunicados da equipe de BI.", "No announcements at this time": "Nenhum aviso no momento",
  "Report unavailable": "Relatório indisponível", "You do not have access to this report, or it has been removed.": "Você não tem acesso a este relatório, ou ele foi removido.",
  "Back to home": "Voltar ao início",

  // ---------------------------------------------------------------- arquivos
  "Spreadsheets and documents shared by the BI team.": "Planilhas e documentos compartilhados pela equipe de BI.",
  "Manage files": "Gerenciar arquivos", "Download": "Baixar", "No files available": "Nenhum arquivo disponível",
  "There are no files shared with you yet.": "Ainda não há arquivos compartilhados com você.",
  "Upload the first file under Manage files.": "Envie o primeiro arquivo em Gerenciar arquivos.",
  "Updated {t}": "Atualizado {t}", "Upload files and choose who can download them.": "Envie arquivos e escolha quem pode baixá-los.",
  "Files are not set up yet": "Os arquivos ainda não estão configurados",
  "Files appear under Files in the top menu for the selected users.": "Os arquivos aparecem em Arquivos, no menu do topo, para os usuários escolhidos.",
  "Upload file": "Enviar arquivo", "File": "Arquivo", "Updated": "Atualizado", "Size": "Tamanho", "Users": "Usuários", "Status": "Situação",
  "Active": "Ativo", "Inactive": "Inativo", "No files uploaded.": "Nenhum arquivo enviado.",
  "Replace with a new version": "Substituir por uma nova versão", "Delete file": "Excluir arquivo",
  "Users will no longer be able to download it.": "Os usuários não poderão mais baixá-lo.",
  "Replace file": "Substituir arquivo", "Edit file": "Editar arquivo", "Upload the new version of": "Envie a nova versão de",
  "Users with access will be notified.": "Quem tem acesso será avisado.", "Title *": "Título *", "e.g. Position Overview": "ex.: Position Overview",
  "Description": "Descrição", "File *": "Arquivo *", "New version *": "Nova versão *", "Replace file (optional)": "Substituir arquivo (opcional)",
  "Excel, PDF or any other file up to 50 MB.": "Excel, PDF ou qualquer outro arquivo de até 50 MB.",
  "Display order": "Ordem de exibição", "File active": "Arquivo ativo", "Who can download": "Quem pode baixar",
  "Administrators can always download.": "Administradores sempre podem baixar.", "No standard users registered.": "Nenhum usuário comum cadastrado.",
  "Please choose a file.": "Escolha um arquivo.", "The file is larger than 50 MB.": "O arquivo tem mais de 50 MB.",
  "Please enter a title.": "Informe um título.", "File uploaded.": "Arquivo enviado.", "File updated.": "Arquivo atualizado.",
  "File deleted.": "Arquivo excluído.", "New version uploaded. Users have been notified.": "Nova versão enviada. Os usuários foram avisados.",
  "is available": "está disponível", "was updated": "foi atualizado", "File ready to download": "Arquivo pronto para baixar",

  // ---------------------------------------------------------------- administração
  "Manage reports, user access and announcements.": "Gerencie relatórios, acessos dos usuários e avisos.",
  "Reports": "Relatórios", "Categories": "Categorias", "Filter reports…": "Filtrar relatórios…", "New report": "Novo relatório",
  "Report": "Relatório", "Category": "Categoria", "Last refresh": "Última atualização", "No reports registered.": "Nenhum relatório cadastrado.",
  "Mark as refreshed now": "Marcar como atualizado agora", "Refresh recorded.": "Atualização registrada.",
  "Refresh recorded. Users have been notified.": "Atualização registrada. Os usuários foram avisados.",
  "Delete report": "Excluir relatório", "The report": "O relatório", "and all access granted to it will be removed.": "e todos os acessos a ele serão removidos.",
  "Report deleted.": "Relatório excluído.", "Edit report": "Editar relatório", "No category": "Sem categoria",
  "Power BI embed link *": "Link de incorporação do Power BI *",
  "In Power BI: File › Embed report › Website or portal (or Publish to web).": "No Power BI: Arquivo › Inserir relatório › Site ou portal (ou Publicar na Web).",
  "Refresh status": "Situação da atualização", "Expected frequency": "Frequência esperada", "Last data refresh": "Última atualização dos dados",
  "Report note": "Nota do relatório", "Text shown on the report (optional)": "Texto exibido no relatório (opcional)",
  "e.g. September figures under review": "ex.: números de setembro em revisão", "Type": "Tipo", "Information / new": "Informação / novidade",
  "Warning": "Alerta", "Critical": "Crítico", "Report active": "Relatório ativo", "Who can view": "Quem pode ver",
  "Administrators automatically see all reports.": "Administradores veem todos os relatórios automaticamente.",
  "Please enter a title.": "Informe um título.", "The link must start with https://": "O link precisa começar com https://",
  "Report added.": "Relatório adicionado.", "Report updated.": "Relatório atualizado.",
  "New category": "Nova categoria", "Order": "Ordem", "No categories.": "Nenhuma categoria.", "Edit category": "Editar categoria",
  "Name *": "Nome *", "Please enter a name.": "Informe um nome.", "Category saved.": "Categoria salva.", "Delete category": "Excluir categoria",
  "Category deleted.": "Categoria excluída.",
  "Filter users…": "Filtrar usuários…", "New user": "Novo usuário", "User": "Usuário", "Role": "Perfil", "Last access": "Último acesso",
  "Administrator": "Administrador", "File manager": "Gestor de arquivos", "All": "Todos", "Never": "Nunca",
  "Password change pending": "Troca de senha pendente", "Invitation pending": "Convite pendente",
  "Set temporary password": "Definir senha provisória", "Define a temporary password for": "Defina uma senha provisória para",
  "They will be required to change it at their next sign-in.": "A pessoa deverá trocá-la no próximo acesso.",
  "Temporary password *": "Senha provisória *", "Password copied.": "Senha copiada.",
  "The temporary password must be at least 8 characters long.": "A senha provisória precisa ter pelo menos 8 caracteres.",
  "If this user also signs in to other systems with the same account (e.g. the Daily Report), the new password applies there too.":
    "Se este usuário também entra em outros sistemas com a mesma conta (ex.: o Daily Report), a nova senha vale lá também.",
  "Delete user": "Excluir usuário",
  "will lose access to the portal (their sign-in to other systems is not affected). To block access temporarily, deactivate the user instead.":
    "perderá o acesso ao portal (o login em outros sistemas não é afetado). Para bloquear temporariamente, desative o usuário.",
  "User deleted.": "Usuário excluído.", "Edit user": "Editar usuário", "Create user": "Criar usuário", "E-mail *": "E-mail *",
  "Access active": "Acesso ativo", "File manager (uploads files)": "Gestor de arquivos (envia arquivos)",
  "Can upload and manage files, without being an administrator": "Pode enviar e gerenciar arquivos sem ser administrador",
  "No e-mail is sent: share this password with the user. They will be required to change it at first sign-in. If the e-mail already has an account (e.g. the Daily Report), access is granted and they keep their current password.":
    "Nenhum e-mail é enviado: repasse esta senha ao usuário. Ele deverá trocá-la no primeiro acesso. Se o e-mail já tiver conta (ex.: o Daily Report), o acesso é liberado e a senha atual é mantida.",
  "Report access": "Acesso aos relatórios", "Administrators see all reports.": "Administradores veem todos os relatórios.",
  "Invalid e-mail address.": "E-mail inválido.", "User updated.": "Usuário atualizado.",
  "Banners appear at the top of every page; board announcements appear on the home page.":
    "Banners aparecem no topo de todas as páginas; avisos do mural aparecem na página inicial.",
  "New announcement": "Novo aviso", "Announcement": "Aviso", "Period": "Período", "Banner": "Banner", "Board": "Mural",
  "Live": "No ar", "Scheduled": "Agendado", "Expired": "Encerrado", "no end date": "sem data de término",
  "No announcements registered.": "Nenhum aviso cadastrado.", "Delete announcement": "Excluir aviso", "Announcement deleted.": "Aviso excluído.",
  "Edit announcement": "Editar aviso", "Display location": "Onde exibir", "Announcement board (home page)": "Mural de avisos (página inicial)",
  "Highlight banner (top of page)": "Banner de destaque (topo da página)", "Level": "Nível", "Information": "Informação",
  "Text": "Texto", "\"Learn more\" link (optional)": "Link \"Saiba mais\" (opcional)", "Image (board only)": "Imagem (só no mural)",
  "Remove image": "Remover imagem", "PNG, JPG or WEBP up to 2 MB.": "PNG, JPG ou WEBP de até 2 MB.", "Start": "Início",
  "End (optional)": "Término (opcional)", "Image is larger than 2 MB.": "A imagem tem mais de 2 MB.",
  "The end date must be after the start date.": "A data de término precisa ser depois da data de início.",
  "The link must start with http:// or https://": "O link precisa começar com http:// ou https://", "Announcement saved.": "Aviso salvo.",

  // ---------------------------------------------------------------- Position: geral
  "Position Overview": "Visão Geral da Posição", "Physical Position": "Posição Física", "Open Contracts": "Contratos em Aberto",
  "Export Sales": "Vendas de Exportação", "Purchases": "Compras",
  "Net position by term month and change vs the previous position — Arabica, Robusta, Exportable and Low Grade.":
    "Posição líquida por mês de vencimento e variação contra a posição anterior — Arábica, Robusta, Exportable e Low Grade.",
  "Net position by term month and change vs the previous position.": "Posição líquida por mês de vencimento e variação contra a posição anterior.",
  "Physical position by month and running balance by quality.": "Posição física por mês e saldo acumulado por qualidade.",
  "Open purchases, export and domestic sales, and inventory, contract by contract.":
    "Compras, vendas de exportação, vendas internas e estoque em aberto, contrato a contrato.",
  "Shipped volume, revenue and sale diff, crop over crop, by client and quality.":
    "Volume embarcado, receita e diferencial de venda, safra contra safra, por cliente e qualidade.",
  "Purchased volume, value and purchase diff, crop over crop, by supplier and quality.":
    "Volume comprado, valor e diferencial de compra, safra contra safra, por fornecedor e qualidade.",
  "Loading Position…": "Carregando a posição…", "Position data is not available": "Os dados da posição não estão disponíveis",
  "No Position uploaded yet": "Nenhuma posição enviada ainda",
  "Upload the daily Position Overview spreadsheet to build these views.": "Envie a planilha diária Position Overview para montar estas visões.",
  "The BI team has not published the Position yet.": "A equipe de BI ainda não publicou a posição.", "Unknown Position view": "Visão desconhecida",
  "Position as of": "Posição de", "· all figures in 60 kg bags": "· valores em sacas de 60 kg", "Upload Position": "Enviar posição",
  "Choose the daily": "Escolha a planilha diária",
  "spreadsheet (.xlsm or .xlsx). It is read in your browser — macros are never run — and the Position views are updated for everyone with access.":
    "(.xlsm ou .xlsx). Ela é lida no seu navegador — as macros nunca são executadas — e as visões da posição são atualizadas para todos que têm acesso.",
  "Spreadsheet *": "Planilha *", "Read and publish": "Ler e publicar", "Please choose the spreadsheet.": "Escolha a planilha.",
  "Position of {n}/{n}/{n} published.": "Posição de {n}/{n}/{n} publicada.",
  "Position is not set up yet: run section 7 of supabase/schema.sql in the Supabase SQL Editor.":
    "A posição ainda não está configurada: rode a seção 7 do supabase/schema.sql no SQL Editor do Supabase.",
  "Only administrators and file managers can upload the Position.": "Só administradores e gestores de arquivos podem enviar a posição.",
  "Unable to load the spreadsheet reader. Check your connection.": "Não foi possível carregar o leitor de planilhas. Verifique sua conexão.",
  "No data available — you may not have access, or the Position needs to be uploaded again.":
    "Sem dados — talvez você não tenha acesso, ou a posição precise ser enviada novamente.",
  "Arabica": "Arábica", "Robusta": "Robusta", "Exportable": "Exportable", "Low Grade": "Low Grade", "Conilon": "Conilon",
  "bags (60 kg)": "sacas (60 kg)", "bags": "sacas", "lots": "lotes", "contracts": "contratos",

  // ---------------------------------------------------------------- Position Overview
  "net outright": "posição outright", "Net outright": "Posição outright", "Net diff position": "Posição de diferencial",
  "Net diff position {n}": "Posição de diferencial {n}", "No change vs previous": "Sem variação vs anterior", "▲ {n} vs previous": "▲ {n} vs anterior",
  "▼ {n} vs previous": "▼ {n} vs anterior", "Net position by term month": "Posição líquida por mês de vencimento",
  "Bars: physical position (purchases and inventory above zero, sales below). Line: net diff position.":
    "Barras: posição física (compras e estoque acima de zero, vendas abaixo). Linha: posição de diferencial.",
  "Term month": "Mês de vencimento", "Cash": "Físico", "Fixed": "Fixado", "PTBF": "PTBF", "Inventory": "Estoque", "Sales": "Vendas",
  "Exp sales": "Vendas exp.", "Int sales": "Vendas int.", "Futures": "Futuros", "Switch exp.": "Switch exp.",
  "Change vs previous position": "Variação vs posição anterior", "Previous": "Anterior",
  "No new trades or fixations in this position.": "Nenhum negócio ou fixação nova nesta posição.",
  "Expected (previous + changes)": "Esperado (anterior + variações)", "Current position": "Posição atual", "Difference": "Diferença",
  "A difference usually comes from physical adjustments — e.g. a contract of 3,667 bags that shipped 3,600.":
    "Diferenças costumam vir de ajustes físicos — ex.: um contrato de 3.667 sacas que embarcou 3.600.",
  "The Variation sheet has no block for this group.": "A aba Variation não tem bloco para este grupo.",
  "Net outright over time": "Posição outright ao longo do tempo",
  "The history builds up with each daily upload — this chart appears from the second Position onwards.":
    "O histórico se forma a cada envio diário — este gráfico aparece a partir da segunda posição.",
  "New Purchases": "Novas compras", "New Int Sales": "Novas vendas internas", "New Exp Sales": "Novas vendas de exportação",
  "Fix Purchases": "Fixação de compras", "Fix Int Sales": "Fixação de vendas internas", "Fix Exp Sales": "Fixação de vendas de exportação",
  "Guias": "Guias",

  // ---------------------------------------------------------------- Physical Position
  "Physical position by month": "Posição física por mês",
  "Bars: inventory, purchases and sales (export + domestic) of each month. Line: running net physical position.":
    "Barras: estoque, compras e vendas (exportação + mercado interno) de cada mês. Linha: posição física acumulada.",
  "Month": "Mês", "Domestic sales": "Vendas internas", "Net (running)": "Saldo acumulado", "Running position by quality": "Posição acumulada por qualidade",
  "Cumulative balance per month for each quality.": "Saldo acumulado por mês para cada qualidade.", "long": "comprado", "short": "vendido",
  "Including purchases": "Com compras", "Without purchases": "Sem compras",
  "The spreadsheet has no term-month breakdown for Exportable — only the total below. The month-by-month view is in Physical Position.":
    "A planilha não abre Exportable por mês de vencimento — só o total abaixo. A visão mês a mês está em Posição Física.",
  "The spreadsheet has no term-month breakdown for Low Grade — only the total below. The month-by-month view is in Physical Position.":
    "A planilha não abre Low Grade por mês de vencimento — só o total abaixo. A visão mês a mês está em Posição Física.",

  // ---------------------------------------------------------------- Open Contracts
  "Contracts unavailable": "Contratos indisponíveis", "Export sales": "Vendas de exportação",
  "Purchases ({n})": "Compras ({n})", "Export sales ({n})": "Vendas de exportação ({n})", "Domestic sales ({n})": "Vendas internas ({n})",
  "Inventory ({n})": "Estoque ({n})", "Search contract, supplier…": "Buscar contrato, fornecedor…",
  "All species": "Todas as espécies", "All qualities": "Todas as qualidades", "All months": "Todos os meses", "Species": "Espécie",
  "Quality": "Qualidade", "Exchange month": "Mês da bolsa", "Fixation": "Fixação",
  "All contracts": "Todos os contratos", "With lots to fix": "Com lotes a fixar", "Overdue or due within {n} days": "Vencidos ou a vencer em até {n} dias",
  "Due within {n} days": "Vencem em até {n} dias", "Fully fixed": "Totalmente fixados", "To fix": "A fixar", "{n} lots": "{n} lotes",
  "{n} contracts": "{n} contratos", "{n} contract": "{n} contrato", "{n} bags": "{n} sacas", "{n}% of the lots fixed": "{n}% dos lotes fixados",
  "No lots in these contracts": "Sem lotes nestes contratos", "Past first notice day": "Passou do primeiro aviso",
  "{n} lots to fix": "{n} lotes a fixar", "Due in {n}–{n} days": "Vencem em {n}–{n} dias",
  "Fix by = estimated first notice day of the exchange month: NY 7 and London 4 business days before the first business day of the month (holidays not counted). Counts are for the filters above.":
    "Prazo = primeiro dia de aviso (FND) estimado do mês da bolsa: NY 7 e Londres 4 dias úteis antes do 1º dia útil do mês (feriados não considerados). Os números seguem os filtros acima.",
  "Upload the Position again to see the fixation indicators and alerts.": "Envie a posição de novo para ver os indicadores e alertas de fixação.",
  "Fixation alert:": "Alerta de fixação:",
  "{n} contract ({n} lots) past the first notice day": "{n} contrato ({n} lotes) após o primeiro dia de aviso",
  "{n} contracts ({n} lots) past the first notice day": "{n} contratos ({n} lotes) após o primeiro dia de aviso",
  "{n} contract ({n} lots) due within {n} days": "{n} contrato ({n} lotes) vence em até {n} dias",
  "{n} contracts ({n} lots) due within {n} days": "{n} contratos ({n} lotes) vencem em até {n} dias",
  "{n} in purchases": "{n} em compras", "{n} in export sales": "{n} em vendas de exportação", "{n} in domestic sales": "{n} em vendas internas",
  "contracts": "contratos", "lots": "lotes", "bags to deliver": "sacas a entregar", "bags to ship": "sacas a embarcar", "bags bags": "sacas",
  "All lots in stock.": "Todos os lotes em estoque.",
  "Open contracts only (to deliver/ship, to fix or to pay/receive).": "Só contratos em aberto (a entregar/embarcar, a fixar ou a pagar/receber).",
  "No contracts match these filters.": "Nenhum contrato com esses filtros.",
  "Contract": "Contrato", "Supplier": "Fornecedor", "Bags": "Sacas", "To deliver": "A entregar", "Delivery": "Entrega", "Exchange": "Bolsa",
  "Diff": "Diferencial", "Fixed by": "Quem fixa", "Lots": "Lotes", "Lots fixed": "Lotes fixados", "Lots to fix": "Lotes a fixar",
  "Fix by (FND)": "Prazo (FND)", "Price R$/bag": "Preço R$/saca", "To pay R$": "A pagar R$", "Certificate": "Certificado",
  "Importer": "Importador", "To ship": "A embarcar", "Est. loading": "Prev. carga", "Shipment": "Embarque", "Final price": "Preço final",
  "Unit": "Unidade", "Incoterm": "Incoterm", "Client": "Cliente", "Est. shipment": "Prev. embarque", "To receive R$": "A receber R$",
  "Lot": "Lote", "Cup": "Bebida", "Screen": "Peneira", "Crop": "Safra", "Warehouse": "Armazém", "Entry": "Entrada", "Cost R$/bag": "Custo R$/saca",
  "Brascof": "Brascof", "today": "hoje", "in {n} d": "em {n} d", "{n} d overdue": "{n} d de atraso",
  "Lots to fix: {s}": "Lotes a fixar: {s}", "Fixation alert": "Alerta de fixação",

  // ---------------------------------------------------------------- Export Sales / Purchases
  "NY (Arabica)": "NY (Arábica)", "London (Robusta)": "Londres (Robusta)", "All clients": "Todos os clientes", "All suppliers": "Todos os fornecedores",
  "Shipped": "Embarcado", "Revenue": "Receita", "Avg final price": "Preço final médio", "Sale diff": "Diferencial de venda",
  "Purchased": "Comprado", "Value R$": "Valor R$", "Avg price": "Preço médio", "Purch diff": "Diferencial de compra",
  "PY: {n}": "Ant.: {n}", "PY": "Ant.", "PY:": "Ant.:", "YOY": "Var.", "Volume": "Volume", "Δ PY": "Δ ant.", "Δ": "Δ",
  "select an exchange": "escolha uma bolsa", "exchange unit": "unidade da bolsa", "Shipped by month": "Embarcado por mês", "Purchased by month": "Comprado por mês",
  "Realized sales: month of the bill of lading (BL); crop from the contract. Crop year July to June.":
    "Vendas realizadas: mês do conhecimento de embarque (BL); safra do contrato. Ano-safra de julho a junho.",
  "Purchases by contract date (issue month); crop from the contract. Crop year July to June.":
    "Compras pela data do contrato (mês de emissão); safra do contrato. Ano-safra de julho a junho.",
  "Report by client": "Por cliente", "Report by quality": "Por qualidade", "Report by quality group": "Por grupo de qualidade",
  "Report by supplier": "Por fornecedor", "Report by type": "Por modalidade", "Quality group": "Grupo de qualidade", "%": "%",
  "No data for these filters.": "Sem dados para esses filtros.", "full crop": "safra completa",
  "same period, before the crop year": "mesmo período, antes do ano-safra", "Compared with {n}/{n}": "Comparado com {n}/{n}",
  "Earlier": "Antes", "Later": "Depois", "(no client)": "(sem cliente)",
  "Upload the Position again to see the screens — the data on the portal was saved before screens were read from the spreadsheet.":
    "Envie a posição de novo para ver as peneiras — os dados do portal foram gravados antes de as peneiras serem lidas da planilha.",
  "Open balance to ship only": "Só saldo a embarcar", "To ship": "A embarcar", "Est. value": "Valor estimado",
  "Balance still to ship · by estimated loading month": "Saldo ainda a embarcar · por mês de previsão de carga",
  "Upload the Position again to see the open balance to ship.": "Envie a posição de novo para ver o saldo a embarcar.",
  "To ship by month": "A embarcar por mês", "Share of the open balance to ship.": "Participação no saldo a embarcar.",
  "Open balance (Saldo) by estimated loading month (Prev. Carga, or the shipment month when there is no estimate); crop from the contract. Value estimated at the final price.":
    "Saldo a embarcar por mês de previsão de carga (Prev. Carga, ou o mês de embarque quando não há previsão); safra do contrato. Valor estimado pelo preço final.",
  "No date": "Sem data", "Contracts": "Contratos",
  "{n} contracts ({n} bags) still without a final price — pending fixation.": "{n} contratos ({n} sacas) ainda sem preço final — pendentes de fixação.",
  "{n} contract ({n} bags) still without a final price — pending fixation.": "{n} contrato ({n} sacas) ainda sem preço final — pendente de fixação.",
  "Value and average price consider only priced contracts.": "Valor e preço médio consideram só os contratos com preço.",
  "Search contract…": "Buscar contrato…", "Quality / screen": "Qualidade / peneira", "Report by quality / screen": "Por qualidade / peneira",
  "% of total": "% do total", "% of quality": "% da qualidade", "Revenue R$": "Receita R$", "Revenue R$ · PTAX D-1": "Receita R$ · PTAX D-1",
  "Avg PTAX": "PTAX média",
  "Revenue R$ = revenue US$ × PTAX (buy) of the business day before each BL. Average PTAX: {n}.":
    "Receita R$ = receita US$ × PTAX de compra do dia útil anterior a cada BL. PTAX média: {n}.",
  "Revenue R$ = revenue US$ × PTAX (buy) of the business day before each BL. Average PTAX: —.":
    "Receita R$ = receita US$ × PTAX de compra do dia útil anterior a cada BL. PTAX média: —.",
  "{n} shipments without PTAX — upload the Position again.": "{n} embarques sem PTAX — envie a posição de novo.",
  "{n} shipments without PTAX.": "{n} embarques sem PTAX.",
  "PTAX could not be loaded from the Central Bank — revenue in R$ will be missing for this upload.":
    "Não foi possível buscar a PTAX no Banco Central — a receita em R$ ficará sem valor neste envio.",
  "Upload the Position again to build this view (it needs the full contract history).":
    "Envie a posição de novo para montar esta visão (ela precisa do histórico completo de contratos).",
  "Jul": "Jul", "Aug": "Ago", "Sep": "Set", "Oct": "Out", "Nov": "Nov", "Dec": "Dez", "Jan": "Jan", "Feb": "Fev", "Mar": "Mar",
  "Apr": "Abr", "May": "Mai", "Jun": "Jun",

  // ---------------------------------------------------------------- Diferenciais médios das exportações
  "Avg diff": "Diferencial médio", "Inclusion date": "Data de inclusão", "EOM Ship": "EOM Ship", "From": "De", "To": "Até",
  "All EOM Ship": "Todos os EOM Ship", "Qualities": "Qualidades", "Quality groups": "Grupos de qualidade",
  "Months counted by inclusion date.": "Meses contados pela data de inclusão.", "Months counted by EOM Ship.": "Meses contados pelo EOM Ship.",
  "Average weighted by bags; Conilon diffs ÷ 100.": "Média ponderada pelas sacas; diferenciais de Conilon ÷ 100.",
  "{n} rows without a diff left out.": "{n} linhas sem diferencial ficaram de fora.",
  "{n} rows without a date left out.": "{n} linhas sem data ficaram de fora.",
  "Avg diff by month": "Diferencial médio por mês", "Line: average sale diff. Bars: bags.": "Linha: diferencial médio de venda. Barras: sacas.",
  "Avg diff by quality and month": "Diferencial médio por qualidade e mês",
  "Avg diff by quality group and month": "Diferencial médio por grupo de qualidade e mês",
  "Each cell: average diff and, below, the bags. Hover a cell for the exact volume.":
    "Cada célula: diferencial médio e, embaixo, as sacas. Passe o mouse para ver o volume exato.",
  "Export sale diffs unavailable": "Diferenciais de exportação indisponíveis", "Average diff by month": "Diferencial médio por mês",
  "Upload the Position again to build this view — it needs the inclusion date and the EOM Ship from the spreadsheet.":
    "Envie a posição de novo para montar esta visão — ela precisa da data de inclusão e do EOM Ship da planilha.",

  // ---------------------------------------------------------------- Commercial Control (TV) e API do Payments
  "Brascof · TV Dashboard": "Brascof · Painel TV", "Commercial Control": "Controle Comercial", "Due/Loading from": "Vencimento/Carga de",
  "to": "até", "Today": "Hoje", "This week": "Esta semana", "Supplier:": "Fornecedor:", "Search...": "Buscar...",
  "Show all for this supplier": "Ver tudo deste fornecedor", "Broker:": "Corretor:", "All ▾": "Todos ▾", "💾 Save image": "💾 Salvar imagem",
  "Next refresh in": "Próxima atualização em", "📄 Coffee Contracts — due": "📄 Contratos de Café — vencimento",
  "🚢 Exports — estimated loading": "🚢 Exportação — previsão de carga", "Loading...": "Carregando...", "Due date": "Vencimento",
  "Branch": "Filial", "Price/Bag": "Preço/saca", "Delivered": "Entregue", "Est. Loading": "Prev. carga", "BL Date": "Data BL",
  "Total purchases:": "Total compras:", "Total sales:": "Total vendas:", "No contracts due in this period.": "Nenhum contrato vencendo neste período.",
  "No exports scheduled in this period.": "Nenhuma exportação prevista neste período.", "No brokers in this period": "Nenhum corretor neste período",
  "No broker": "Sem corretor", "{n} selected": "{n} selecionados", "Generating...": "Gerando...", "Error fetching data": "Erro ao buscar dados",
  "Paid: R$ {n}": "Pago: R$ {n}", "Outstanding: R$ {n}": "Falta: R$ {n}",
  "Sign in to the BI Portal to view this page.": "Entre no Portal BI para ver esta página.",
  "Your session has expired. Please reload the BI Portal.": "Sua sessão expirou. Recarregue o Portal BI.",
  "You do not have access to this report.": "Você não tem acesso a este relatório.",
  "Unable to check your access right now. Please try again.": "Não foi possível verificar seu acesso agora. Tente novamente.",
  "on {n}/{n}/{n}": "em {n}/{n}/{n}", "between {n}/{n}/{n} and {n}/{n}/{n}": "entre {n}/{n}/{n} e {n}/{n}/{n}",
};

// Tempo relativo produzido por ui.tempoRelativo
const RE_TEMPO = /\b(just now|yesterday|\d+ min ago|\d+ h ago|\d+ days ago)\b/;
function tempo(s) {
  if (IDIOMA !== "pt") return s;
  if (s === "just now") return "agora";
  if (s === "yesterday") return "ontem";
  return s.replace(/^(\d+) min ago$/, "há $1 min").replace(/^(\d+) h ago$/, "há $1 h").replace(/^(\d+) days ago$/, "há $1 dias");
}

const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Casos com nomes, e-mails ou trechos variáveis que não são números
const ESPECIAIS = [
  [/^© (\d{4}) (.+)\. Restricted access — authorized personnel only\.$/, (m) => `© ${m[1]} ${m[2]}. Acesso restrito — somente pessoas autorizadas.`],
  [/^(.+) → no end date$/, (m) => `${m[1]} → sem data de término`],
  [/^(.+), (Arabica|Robusta|Exportable|Low Grade)$/, (m) => (traduzirTexto(m[1]) != null ? `${traduzirTexto(m[1])}, ${PT[m[2]]}` : null)],
  [/^(Shipped|Purchased) by month, this crop and previous crop$/, (m) => `${PT[`${m[1]} by month`]}, safra atual e anterior`],
  [/^(Good morning|Good afternoon|Good evening), (.+)$/, (m) => `${PT[m[1]]}, ${m[2]}`],
  [/^Welcome, (.+)$/, (m) => `Bem-vindo(a), ${m[1]}`],
  [/^· uploaded (.+?)(?: by (.+))?$/, (m) => `· enviada ${tempo(m[1])}${m[2] ? ` por ${m[2]}` : ""}`],
  [/^Temporary password set for (.+)\. Share it with the user\.$/, (m) => `Senha provisória definida para ${m[1]}. Repasse-a ao usuário.`],
  [/^User created\. Share the temporary password with (.+)\.$/, (m) => `Usuário criado. Repasse a senha provisória para ${m[1]}.`],
  [/^(.+) already had an account: access granted with their existing password\.$/, (m) => `${m[1]} já tinha conta: acesso liberado com a senha atual.`],
  [/^A link from (.+) \(e\.g\. the Daily Report\) becomes an integrated system: it opens with the same sign-in and appears in the top menu\.$/,
    (m) => `Um link de ${m[1]} (ex.: o Daily Report) vira um sistema integrado: abre com o mesmo login e aparece no menu do topo.`],
  [/^Its (\d+) report\(s\) will be moved to "Other"\.$/, (m) => `Seus ${m[1]} relatório(s) irão para "Outros".`],
  [/^(\w{3})–(\w{3}), same period$/, (m) => `${PT[m[1]] ?? m[1]}–${PT[m[2]] ?? m[2]}, mesmo período`],
  [/^(.+) \((\w{3})–(\w{3}), same period\)$/, (m) => `${m[1]} (${PT[m[2]] ?? m[2]}–${PT[m[3]] ?? m[3]}, mesmo período)`],
  [/^Volume share and change vs (.+) \((.+)\)\.(?: (.+))?$/, (m) => `Participação no volume e variação vs ${m[1]} (${traduzirTexto(m[2]) ?? m[2]}).${m[3] ? ` ${traduzirTexto(m[3]) ?? m[3]}` : ""}`],
  [/^Click a (client|supplier) to filter the page\.$/, (m) => `Clique em um ${m[1] === "client" ? "cliente" : "fornecedor"} para filtrar a página.`],
  [/^(.+) unavailable$/, (m) => `${traduzirTexto(m[1]) ?? m[1]} indisponível`],
  [/^Searching all contracts for "(.+)"\.\.\.$/, (m) => `Buscando todos os contratos de "${m[1]}"...`],
  [/^on any date \("(.+)"\)$/, (m) => `em qualquer data ("${m[1]}")`],
  [/^— No broker — \((\d+)\)$/, (m) => `— Sem corretor — (${m[1]})`],
  [/^Error loading Digisul data: (.+)$/, (m) => `Erro ao carregar dados do Digisul: ${traduzirTexto(m[1]) ?? m[1]}`],
  [/^Warning: Digisul query partially failed \((.+)\)\. The data below may be incomplete\.$/,
    (m) => `Aviso: falha parcial ao consultar o Digisul (${m[1]}). Os dados abaixo podem estar incompletos.`],
  [/^PTAX buy rate D-1 \((.+)\): (.+)$/, (m) => `PTAX compra D-1 (${m[1]}): ${m[2]}`],
  [/^Error generating image: (.+)$/, (m) => `Erro ao gerar imagem: ${m[1]}`],
  [/^Error: (.+)$/, (m) => `Erro: ${traduzirTexto(m[1]) ?? m[1]}`],
  [/^"(.+)": (.+)$/, (m) => `"${m[1]}": ${traduzirTexto(m[2]) ?? m[2]}`],
  [/^(\w{3})-(\d{2})$/, (m) => (MESES.includes(m[1]) ? `${PT[m[1]]}/${m[2]}` : null)], // Dec-26 → Dez/26
];

// número com separadores; não engole a pontuação do fim ("5,1224." → "5,1224")
const RE_NUM = /[-+−]?\d(?:[\d.,]*\d)?/g;

// Tradução de um texto solto da tela; null quando não há tradução
function traduzirTexto(bruto) {
  if (IDIOMA !== "pt" || bruto == null) return null;
  const s = String(bruto).replace(/\s+/g, " ").trim();
  if (!s || !/[A-Za-z]/.test(s)) return null;
  if (PT[s] != null) return PT[s];
  // "·" solto no começo ou no fim (texto que continua em outro elemento)
  const pontas = s.match(/^(· )?(.*?)( ·)?$/);
  if ((pontas[1] || pontas[3]) && pontas[2]) {
    const meio = traduzirTexto(pontas[2]);
    if (meio != null) return `${pontas[1] ?? ""}${meio}${pontas[3] ?? ""}`;
  }
  for (const [re, fn] of ESPECIAIS) {
    const m = s.match(re);
    if (m) { const r = fn(m); if (r != null) return r; }
  }
  // trechos separados por " · ": cada um por conta própria
  if (s.includes(" · ")) {
    const partes = s.split(" · ");
    const tr = partes.map((p) => traduzirTexto(p));
    if (tr.some((x) => x != null)) return partes.map((p, i) => tr[i] ?? p).join(" · ");
  }
  // tempo relativo: "Refreshed 3 min ago" → "Atualizado há 3 min"
  const mt = s.match(RE_TEMPO);
  if (mt) {
    if (s === mt[0]) return tempo(s);
    const chave = s.replace(mt[0], "{t}");
    if (PT[chave] != null) return PT[chave].replace("{t}", tempo(mt[0]));
  }
  // números: "51 contracts" → "{n} contracts" → "{n} contratos"
  const nums = s.match(RE_NUM);
  if (nums) {
    const chave = s.replace(RE_NUM, "{n}");
    if (PT[chave] != null) { let i = 0; return PT[chave].replace(/\{n\}/g, () => nums[i++] ?? ""); }
  }
  return null;
}

// Texto para código (gráficos, títulos de janela): traduz e preenche {variáveis}
export function t(texto, vars) {
  let s = (IDIOMA === "pt" && (PT[texto] ?? traduzirTexto(texto))) || texto;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  return s;
}

const ATRIBUTOS = ["placeholder", "title", "aria-label"];
const PULAR = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);

function traduzirNoTexto(no) {
  const pai = no.parentElement;
  if (!pai || PULAR.has(pai.tagName) || pai.closest("[data-sem-traducao]")) return;
  const r = traduzirTexto(no.data);
  if (r == null) return;
  // mantém os espaços em volta do texto original
  const ini = no.data.match(/^\s*/)[0], fim = no.data.match(/\s*$/)[0];
  const novo = ini + r + fim;
  if (novo !== no.data) no.data = novo;
}

function traduzirElemento(el) {
  if (el.closest?.("[data-sem-traducao]")) return;
  for (const a of ATRIBUTOS) {
    if (!el.hasAttribute(a)) continue;
    const r = traduzirTexto(el.getAttribute(a));
    if (r != null && r !== el.getAttribute(a)) el.setAttribute(a, r);
  }
}

function traduzirArvore(raiz) {
  if (raiz.nodeType === 3) return traduzirNoTexto(raiz);
  if (raiz.nodeType !== 1 || PULAR.has(raiz.tagName)) return;
  traduzirElemento(raiz);
  const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) traduzirNoTexto(n); else traduzirElemento(n);
  }
}

// Liga a tradução automática da página (não faz nada em inglês)
export function ligarTraducao(raiz = document.body) {
  if (IDIOMA !== "pt") return;
  document.documentElement.lang = "pt-BR";
  document.title = t(document.title);
  traduzirArvore(raiz);
  new MutationObserver((mudancas) => {
    for (const m of mudancas) {
      if (m.type === "characterData") traduzirNoTexto(m.target);
      else m.addedNodes.forEach(traduzirArvore);
    }
  }).observe(raiz, { childList: true, subtree: true, characterData: true });
}
