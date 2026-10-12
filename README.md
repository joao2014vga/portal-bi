# Portal BI

Portal único para os painéis do Power BI, com login, controle de acesso por usuário e informativos (banner, mural de avisos, notas e status de atualização de cada painel).

- **Banco + login:** Supabase (Postgres, Auth, Storage, Edge Function)
- **Hospedagem:** GitHub Pages (site estático: HTML, CSS e JavaScript, sem build)

Enquanto `js/config.js` estiver vazio, o portal abre em **modo demonstração**, com dados fictícios salvos só no seu navegador.
- ADM: `admin@demo.com`
- Usuário: `mariana@demo.com`
- Senha dos dois: `demo1234`

---

## Estrutura

```
index.html                 página única do portal
css/style.css              visual (cor da marca em --brand)
js/config.js               URL e chave do Supabase  ← você edita
js/app.js                  telas e navegação
js/api.js                  acesso ao Supabase
js/demo.js                 dados do modo demonstração
js/ui.js                   utilidades (modal, toast, ícones)
supabase/schema.sql        tabelas + regras de segurança (RLS)
supabase/functions/bi-admin-users/index.ts   convite/exclusão de usuários
```

## 1. Configurar o Supabase

1. Crie um projeto em https://supabase.com (ou use um que você já tem).
2. **SQL Editor** → cole e rode o conteúdo de `supabase/schema.sql`.
   Todas as tabelas usam o prefixo `bi_` (`bi_perfis`, `bi_dashboards`…), então o script pode rodar num projeto que já tem outros sistemas — ele não mexe em `profiles`, triggers ou funções existentes.
3. **Quem entra no portal:** só quem tem linha em `bi_perfis`. Uma pessoa que tem login em outro sistema do mesmo projeto, mas não foi liberada no portal, é barrada no login. Por isso **não é preciso** desligar o cadastro público ("Allow new users to sign up"); se o projeto for só do portal, pode desligar.
4. **Authentication → URL Configuration → Redirect URLs**: adicione o endereço do portal, ex.: `https://SEU-USUARIO.github.io/portal-bi/` (e `http://localhost:8000/` para testes).
   **Não altere a *Site URL*** se o projeto for compartilhado: ela é usada pelos outros sistemas. O portal informa o próprio endereço em cada e-mail.
5. **Authentication → Emails** (opcional): traduza os modelos "Invite user" e "Reset password" para português.
6. **E-mail em produção:** o servidor de e-mail padrão do Supabase tem limite baixo (poucos e-mails/hora). Em **Project Settings → Authentication → SMTP** configure o SMTP da empresa (Office 365, Gmail, SendGrid etc.).

### Publicar a Edge Function (convites)

Com a [Supabase CLI](https://supabase.com/docs/guides/cli) instalada:

```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase functions deploy bi-admin-users
```

A função usa as variáveis `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`, que o Supabase já fornece automaticamente. **Nunca** coloque a *service role key* no front-end.

> Sem a CLI: em **Edge Functions → Deploy a new function → Via Editor**, crie `bi-admin-users` e cole o conteúdo de `index.ts`.

### Criar o primeiro administrador

1. Use um login que já exista em **Authentication → Users** (pode ser o mesmo dos outros sistemas). Se não houver, crie em *Add user → Create new user* marcando *Auto Confirm User*.
2. No SQL Editor (troque o e-mail):
   ```sql
   insert into public.bi_perfis (id, nome, email, is_admin)
   select id, 'João Otavio Souza', email, true
   from auth.users where email = 'jsouza@brascof.com'
   on conflict (id) do update set is_admin = true, ativo = true;
   ```
Daí em diante, todos os outros usuários são convidados pela tela **Administração → Usuários**:
- e-mail novo → recebe convite para criar senha;
- e-mail que já tem login em outro sistema → o acesso é liberado na hora e ele entra com a senha que já usa;
- **Excluir** remove só o acesso ao portal; o login nos outros sistemas continua funcionando.

## 2. Ligar o portal ao Supabase

Edite `js/config.js` com os dados de **Project Settings → API**:

```js
SUPABASE_URL: "https://xxxx.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi...",   // chave "anon public"
```

A chave *anon* pode ficar pública: quem protege os dados são as regras RLS do `schema.sql`.

## 3. Publicar no GitHub Pages

1. Crie um repositório (ex.: `portal-bi`) e envie todos os arquivos desta pasta.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
3. Em 1–2 minutos o portal fica em `https://SEU-USUARIO.github.io/portal-bi/`.
4. Confira se esse endereço está nas *Redirect URLs* do Supabase (passo 1.4).

Testar no computador: `python -m http.server 8000` dentro da pasta e abra `http://localhost:8000`.

## Como funciona

| Recurso | Onde |
|---|---|
| Login, "esqueci minha senha", definir senha pelo convite | Supabase Auth |
| Usuário vê só os painéis liberados para ele | tabela `bi_acessos` + RLS |
| ADM vê e gerencia tudo | `bi_perfis.is_admin` |
| Banner no topo / mural de avisos com imagem, início e fim | tabela `bi_avisos` + bucket `bi-avisos` |
| Nota no painel (info / alerta / crítico) | `bi_dashboards.nota` |
| Status de atualização (verde / atrasado) | `bi_dashboards.atualizado_em` + `frequencia` |

O status fica "atrasado" quando passa do limite da frequência: a cada hora (2 h), diária (26 h), semanal (8 dias), mensal (32 dias). Na lista de painéis do ADM, o botão ↻ marca "atualizado agora".

## Segurança dos links do Power BI

O portal controla **quem vê o card e abre o painel**. O nível de proteção do relatório em si depende do tipo de link:

- **Publicar na Web** (`app.powerbi.com/view?r=...`): o link é público. Quem tiver o endereço abre sem login. Use só para dados não sensíveis.
- **Inserir → Site ou portal** (`reportEmbed?...&autoAuth=true`): o Power BI pede login da conta Microsoft e respeita as permissões do workspace (exige licença Pro/PPU ou capacidade Premium/Fabric). É o recomendado para dados internos.
- **Power BI Embedded (app owns data):** usuários sem licença, com token gerado no servidor. Dá para fazer com outra Edge Function + um App Registration no Azure — fica como próxima etapa, se precisar.

## Próximos passos possíveis

- Atualizar `atualizado_em` automaticamente pela API do Power BI (histórico de refresh) com uma Edge Function agendada.
- Registrar quais painéis cada usuário abre (estatísticas de uso).
- Migrar categorias e painéis do MySQL antigo (as senhas antigas não migram; os usuários recebem convite).
