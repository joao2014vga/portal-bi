-- =====================================================================
-- PORTAL BI — Schema do banco (Supabase / Postgres)
--
-- Tudo usa o prefixo "bi_" para conviver com outros sistemas no mesmo
-- projeto Supabase (ex.: uma tabela "profiles" que já exista).
-- Este script NÃO altera tabelas, funções ou triggers de outros sistemas
-- (única exceção: um gatilho de notificação em "lancamentos", do Informativo
-- — ver seção 5) e pode ser rodado mais de uma vez com segurança.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELAS
-- ---------------------------------------------------------------------

-- Usuários com acesso ao portal (1:1 com auth.users).
-- Só quem tem linha aqui consegue entrar no portal.
create table if not exists public.bi_perfis (
  id          uuid primary key references auth.users (id) on delete cascade,
  nome        text not null default '',
  email       text not null default '',
  is_admin    boolean not null default false,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.bi_categorias (
  id          bigint generated always as identity primary key,
  nome        text not null unique,
  ordem       int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.bi_dashboards (
  id              bigint generated always as identity primary key,
  categoria_id    bigint references public.bi_categorias (id) on delete set null,
  titulo          text not null,
  descricao       text,
  link            text not null,                 -- URL de incorporação do Power BI
  nota            text,                          -- ex.: "Dados de outubro em validação"
  nota_tipo       text not null default 'info'
                  check (nota_tipo in ('info', 'alerta', 'critico')),
  atualizado_em   timestamptz,                   -- última atualização dos dados
  frequencia      text not null default 'diaria'
                  check (frequencia in ('horaria', 'diaria', 'semanal', 'mensal', 'manual')),
  ativo           boolean not null default true,
  ordem           int not null default 0,
  created_at      timestamptz not null default now()
);

-- Quais usuários podem ver quais dashboards
create table if not exists public.bi_acessos (
  user_id       uuid   not null references public.bi_perfis (id) on delete cascade,
  dashboard_id  bigint not null references public.bi_dashboards (id) on delete cascade,
  primary key (user_id, dashboard_id)
);
create index if not exists bi_acessos_dash_idx on public.bi_acessos (dashboard_id);

-- Mural de avisos e banner de destaque
create table if not exists public.bi_avisos (
  id          bigint generated always as identity primary key,
  tipo        text not null default 'mural' check (tipo in ('mural', 'banner')),
  nivel       text not null default 'info'  check (nivel in ('info', 'alerta', 'critico')),
  titulo      text not null,
  conteudo    text,
  imagem_url  text,
  link        text,
  inicio      timestamptz not null default now(),
  fim         timestamptz,                       -- null = sem data para sair
  ativo       boolean not null default true,
  created_by  uuid references public.bi_perfis (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. FUNÇÕES AUXILIARES
-- ---------------------------------------------------------------------

-- Usuário logado é administrador ativo do portal?
create or replace function public.bi_is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select p.is_admin and p.ativo from public.bi_perfis p where p.id = auth.uid()),
    false
  );
$$;

-- Usuário logado tem acesso ativo ao portal?
create or replace function public.bi_is_ativo()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select p.ativo from public.bi_perfis p where p.id = auth.uid()), false);
$$;

-- Impede que um usuário comum se promova a ADM ou se reative
create or replace function public.bi_protege_perfil()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.bi_is_admin() then
    new.is_admin := old.is_admin;
    new.ativo    := old.ativo;
    new.email    := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists bi_perfis_protege on public.bi_perfis;
create trigger bi_perfis_protege
  before update on public.bi_perfis
  for each row execute function public.bi_protege_perfil();

-- ---------------------------------------------------------------------
-- 3. SEGURANÇA (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.bi_perfis     enable row level security;
alter table public.bi_categorias enable row level security;
alter table public.bi_dashboards enable row level security;
alter table public.bi_acessos    enable row level security;
alter table public.bi_avisos     enable row level security;

-- PERFIS: cada um vê o próprio; ADM vê e altera todos
drop policy if exists bi_perfis_select on public.bi_perfis;
create policy bi_perfis_select on public.bi_perfis for select to authenticated
  using (id = auth.uid() or public.bi_is_admin());

drop policy if exists bi_perfis_update on public.bi_perfis;
create policy bi_perfis_update on public.bi_perfis for update to authenticated
  using (id = auth.uid() or public.bi_is_admin())
  with check (id = auth.uid() or public.bi_is_admin());
-- (inclusão/exclusão de perfis acontece pela Edge Function bi-admin-users)

-- CATEGORIAS: usuários do portal leem; ADM escreve
drop policy if exists bi_categorias_select on public.bi_categorias;
create policy bi_categorias_select on public.bi_categorias for select to authenticated
  using (public.bi_is_ativo());

drop policy if exists bi_categorias_admin on public.bi_categorias;
create policy bi_categorias_admin on public.bi_categorias for all to authenticated
  using (public.bi_is_admin()) with check (public.bi_is_admin());

-- DASHBOARDS: usuário vê só os liberados (e ativos); ADM vê todos
drop policy if exists bi_dashboards_select on public.bi_dashboards;
create policy bi_dashboards_select on public.bi_dashboards for select to authenticated
  using (
    public.bi_is_admin()
    or (
      ativo and public.bi_is_ativo() and exists (
        select 1 from public.bi_acessos a
        where a.dashboard_id = bi_dashboards.id and a.user_id = auth.uid()
      )
    )
  );

drop policy if exists bi_dashboards_admin on public.bi_dashboards;
create policy bi_dashboards_admin on public.bi_dashboards for all to authenticated
  using (public.bi_is_admin()) with check (public.bi_is_admin());

-- ACESSOS: usuário vê os próprios; ADM gerencia
drop policy if exists bi_acessos_select on public.bi_acessos;
create policy bi_acessos_select on public.bi_acessos for select to authenticated
  using (user_id = auth.uid() or public.bi_is_admin());

drop policy if exists bi_acessos_admin on public.bi_acessos;
create policy bi_acessos_admin on public.bi_acessos for all to authenticated
  using (public.bi_is_admin()) with check (public.bi_is_admin());

-- AVISOS: usuários do portal veem os vigentes; ADM gerencia todos
drop policy if exists bi_avisos_select on public.bi_avisos;
create policy bi_avisos_select on public.bi_avisos for select to authenticated
  using (
    public.bi_is_admin()
    or (public.bi_is_ativo() and ativo and inicio <= now() and (fim is null or fim > now()))
  );

drop policy if exists bi_avisos_admin on public.bi_avisos;
create policy bi_avisos_admin on public.bi_avisos for all to authenticated
  using (public.bi_is_admin()) with check (public.bi_is_admin());

-- ---------------------------------------------------------------------
-- 4. STORAGE — imagens dos avisos (bucket público para leitura)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('bi-avisos', 'bi-avisos', true)
on conflict (id) do nothing;

drop policy if exists bi_avisos_img_insert on storage.objects;
create policy bi_avisos_img_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bi-avisos' and public.bi_is_admin());

drop policy if exists bi_avisos_img_update on storage.objects;
create policy bi_avisos_img_update on storage.objects for update to authenticated
  using (bucket_id = 'bi-avisos' and public.bi_is_admin());

drop policy if exists bi_avisos_img_delete on storage.objects;
create policy bi_avisos_img_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bi-avisos' and public.bi_is_admin());

-- ---------------------------------------------------------------------
-- 5. NOTIFICAÇÕES (sininho no topo do portal)
-- Geradas automaticamente pelo banco:
--   - quando a data de atualização de um painel avança (botão ↻ na
--     Administração ou "Last data refresh" no formulário);
--   - a cada New Entry no Informativo (tabela lancamentos), para quem tem
--     acesso ao painel do Informativo (link contendo "informativo-diario").
-- Cada usuário só vê as notificações dos painéis que ele pode ver.
-- ---------------------------------------------------------------------
create table if not exists public.bi_notificacoes (
  id            bigint generated always as identity primary key,
  dashboard_id  bigint not null references public.bi_dashboards (id) on delete cascade,
  titulo        text not null,
  mensagem      text,
  autor         uuid default auth.uid(),            -- quem causou (não recebe aviso de si mesmo)
  created_at    timestamptz not null default now()
);
create index if not exists bi_notificacoes_criada_idx on public.bi_notificacoes (created_at desc);

-- Até quando o usuário já viu as notificações (abriu o sininho)
alter table public.bi_perfis add column if not exists notif_vistas_em timestamptz not null default now();

alter table public.bi_notificacoes enable row level security;

-- A subconsulta em bi_dashboards passa pelo RLS dela: vê a notificação
-- quem vê o painel
drop policy if exists bi_notificacoes_select on public.bi_notificacoes;
create policy bi_notificacoes_select on public.bi_notificacoes for select to authenticated
  using (exists (select 1 from public.bi_dashboards d where d.id = dashboard_id));

-- Painel atualizado. Ignora datas antigas preenchidas à mão (mais de 1 h atrás).
create or replace function public.bi_notifica_dashboard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.atualizado_em is not null
     and new.atualizado_em > coalesce(old.atualizado_em, '-infinity'::timestamptz)
     and new.atualizado_em > now() - interval '1 hour' then
    insert into public.bi_notificacoes (dashboard_id, titulo)
    values (new.id, new.titulo || ' was updated');
  end if;
  return new;
end;
$$;

drop trigger if exists bi_dashboards_notifica on public.bi_dashboards;
create trigger bi_dashboards_notifica
  after update of atualizado_em on public.bi_dashboards
  for each row execute function public.bi_notifica_dashboard();

-- New Entry no Informativo. Lê os campos via jsonb (não quebra se a tabela
-- mudar) e nunca impede o lançamento: qualquer erro aqui é ignorado.
create or replace function public.bi_notifica_lancamento()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  j     jsonb := to_jsonb(new);
  autor text;
begin
  begin
    select nullif(split_part(p.nome, ' ', 1), '') into autor
      from public.bi_perfis p where p.id = auth.uid();

    insert into public.bi_notificacoes (dashboard_id, titulo, mensagem)
    select d.id, d.titulo || ' — new entry',
           concat_ws(' · ',
             case j->>'tipo' when 'COMPRA' then 'Purchase' when 'VENDA' then 'Sale' else j->>'tipo' end,
             case when j->>'sacas' is not null then round((j->>'sacas')::numeric)::text || ' bags' end,
             nullif(j->>'qual', ''),
             nullif(j->>'especie', ''),
             case when autor is not null then 'by ' || autor end)
      from public.bi_dashboards d
     where d.link ilike '%informativo-diario%';
  exception when others then
    raise warning 'bi_notifica_lancamento: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Só acrescenta um gatilho AFTER INSERT em lancamentos (tabela do
-- Informativo); não altera colunas nem dados dela.
do $$
begin
  if to_regclass('public.lancamentos') is not null then
    execute 'drop trigger if exists bi_lancamentos_notifica on public.lancamentos';
    execute 'create trigger bi_lancamentos_notifica after insert on public.lancamentos
             for each row execute function public.bi_notifica_lancamento()';
  end if;
end;
$$;

-- Tempo real: quem está com o portal aberto recebe o aviso na hora
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bi_notificacoes') then
    alter publication supabase_realtime add table public.bi_notificacoes;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. ARQUIVOS PARA DOWNLOAD (ex.: planilha de Position)
-- O ADM sobe o arquivo; os usuários liberados baixam por um link
-- temporário. Bucket privado: ninguém baixa sem login e permissão.
-- ---------------------------------------------------------------------
create table if not exists public.bi_arquivos (
  id             bigint generated always as identity primary key,
  titulo         text not null,
  descricao      text,
  caminho        text not null,                    -- objeto no bucket bi-arquivos
  nome_arquivo   text not null,                    -- nome original, usado no download
  tamanho        bigint,
  atualizado_em  timestamptz not null default now(),
  ativo          boolean not null default true,
  ordem          int not null default 0,
  created_at     timestamptz not null default now()
);

create table if not exists public.bi_arquivo_acessos (
  user_id     uuid   not null references public.bi_perfis (id) on delete cascade,
  arquivo_id  bigint not null references public.bi_arquivos (id) on delete cascade,
  primary key (user_id, arquivo_id)
);
create index if not exists bi_arquivo_acessos_arq_idx on public.bi_arquivo_acessos (arquivo_id);

alter table public.bi_arquivos        enable row level security;
alter table public.bi_arquivo_acessos enable row level security;

drop policy if exists bi_arquivos_select on public.bi_arquivos;
create policy bi_arquivos_select on public.bi_arquivos for select to authenticated
  using (
    public.bi_is_admin()
    or (
      ativo and public.bi_is_ativo() and exists (
        select 1 from public.bi_arquivo_acessos a
        where a.arquivo_id = bi_arquivos.id and a.user_id = auth.uid()
      )
    )
  );

drop policy if exists bi_arquivos_admin on public.bi_arquivos;
create policy bi_arquivos_admin on public.bi_arquivos for all to authenticated
  using (public.bi_is_admin()) with check (public.bi_is_admin());

drop policy if exists bi_arquivo_acessos_select on public.bi_arquivo_acessos;
create policy bi_arquivo_acessos_select on public.bi_arquivo_acessos for select to authenticated
  using (user_id = auth.uid() or public.bi_is_admin());

drop policy if exists bi_arquivo_acessos_admin on public.bi_arquivo_acessos;
create policy bi_arquivo_acessos_admin on public.bi_arquivo_acessos for all to authenticated
  using (public.bi_is_admin()) with check (public.bi_is_admin());

-- Bucket privado, até 50 MB por arquivo
insert into storage.buckets (id, name, public, file_size_limit)
values ('bi-arquivos', 'bi-arquivos', false, 52428800)
on conflict (id) do nothing;

-- Baixa quem vê o registro em bi_arquivos (a subconsulta passa pelo RLS dela)
drop policy if exists bi_arquivos_obj_select on storage.objects;
create policy bi_arquivos_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'bi-arquivos'
         and exists (select 1 from public.bi_arquivos a where a.caminho = storage.objects.name));

drop policy if exists bi_arquivos_obj_insert on storage.objects;
create policy bi_arquivos_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bi-arquivos' and public.bi_is_admin());

drop policy if exists bi_arquivos_obj_update on storage.objects;
create policy bi_arquivos_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'bi-arquivos' and public.bi_is_admin());

drop policy if exists bi_arquivos_obj_delete on storage.objects;
create policy bi_arquivos_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bi-arquivos' and public.bi_is_admin());

-- Notificações também para arquivos (novo ou substituído)
alter table public.bi_notificacoes alter column dashboard_id drop not null;
alter table public.bi_notificacoes add column if not exists
  arquivo_id bigint references public.bi_arquivos (id) on delete cascade;

-- Substitui a política da seção 5: vê a notificação quem vê o painel ou o arquivo
drop policy if exists bi_notificacoes_select on public.bi_notificacoes;
create policy bi_notificacoes_select on public.bi_notificacoes for select to authenticated
  using (
    (dashboard_id is not null and exists (select 1 from public.bi_dashboards d where d.id = dashboard_id))
    or (arquivo_id is not null and exists (select 1 from public.bi_arquivos a where a.id = arquivo_id))
  );

create or replace function public.bi_notifica_arquivo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.ativo and (tg_op = 'INSERT' or new.atualizado_em > old.atualizado_em) then
    insert into public.bi_notificacoes (arquivo_id, titulo, mensagem)
    values (new.id, new.titulo || case when tg_op = 'INSERT' then ' is available' else ' was updated' end,
            'File ready to download');
  end if;
  return new;
end;
$$;

drop trigger if exists bi_arquivos_notifica on public.bi_arquivos;
create trigger bi_arquivos_notifica
  after insert or update of atualizado_em on public.bi_arquivos
  for each row execute function public.bi_notifica_arquivo();

-- ---------------------------------------------------------------------
-- 7. PRIMEIRO ADMINISTRADOR
-- Use um usuário que já exista em Authentication > Users (pode ser o
-- mesmo login que você usa nos outros sistemas). Troque o e-mail e rode:
--
--   insert into public.bi_perfis (id, nome, email, is_admin)
--   select id, 'João Otavio Souza', email, true
--   from auth.users where email = 'jsouza@brascof.com'
--   on conflict (id) do update set is_admin = true, ativo = true;
-- ---------------------------------------------------------------------
