-- =====================================================================
-- PORTAL BI — Schema do banco (Supabase / Postgres)
--
-- Tudo usa o prefixo "bi_" para conviver com outros sistemas no mesmo
-- projeto Supabase (ex.: uma tabela "profiles" que já exista).
-- Este script NÃO altera tabelas, funções ou triggers de outros sistemas
-- e pode ser rodado mais de uma vez com segurança.
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
-- 5. PRIMEIRO ADMINISTRADOR
-- Use um usuário que já exista em Authentication > Users (pode ser o
-- mesmo login que você usa nos outros sistemas). Troque o e-mail e rode:
--
--   insert into public.bi_perfis (id, nome, email, is_admin)
--   select id, 'João Otavio Souza', email, true
--   from auth.users where email = 'jsouza@brascof.com'
--   on conflict (id) do update set is_admin = true, ativo = true;
-- ---------------------------------------------------------------------
