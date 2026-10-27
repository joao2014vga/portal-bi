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
-- "File manager": sobe e gerencia os arquivos da seção 6 sem ser ADM
alter table public.bi_perfis add column if not exists gerencia_arquivos boolean not null default false;

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

-- Usuário logado pode gerenciar os arquivos para download? (ADM ou File manager)
create or replace function public.bi_gerencia_arquivos()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select (p.is_admin or p.gerencia_arquivos) and p.ativo from public.bi_perfis p where p.id = auth.uid()),
    false
  );
$$;

-- Impede que um usuário comum se promova a ADM ou se reative
create or replace function public.bi_protege_perfil()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.bi_is_admin() then
    new.is_admin := old.is_admin;
    new.gerencia_arquivos := old.gerencia_arquivos;
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

-- PERFIS: cada um vê o próprio; ADM vê e altera todos; o File manager vê a
-- lista (só leitura) para escolher quem baixa cada arquivo
drop policy if exists bi_perfis_select on public.bi_perfis;
create policy bi_perfis_select on public.bi_perfis for select to authenticated
  using (id = auth.uid() or public.bi_is_admin() or public.bi_gerencia_arquivos());

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
  -- a publicação do Position marca vários painéis de uma vez e avisa só por um
  if coalesce(current_setting('bi.sem_notificacao', true), '') = '1' then
    return new;
  end if;
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
-- Gerenciar = ADM ou File manager (bi_gerencia_arquivos)
create policy bi_arquivos_select on public.bi_arquivos for select to authenticated
  using (
    public.bi_gerencia_arquivos()
    or (
      ativo and public.bi_is_ativo() and exists (
        select 1 from public.bi_arquivo_acessos a
        where a.arquivo_id = bi_arquivos.id and a.user_id = auth.uid()
      )
    )
  );

drop policy if exists bi_arquivos_admin on public.bi_arquivos;
create policy bi_arquivos_admin on public.bi_arquivos for all to authenticated
  using (public.bi_gerencia_arquivos()) with check (public.bi_gerencia_arquivos());

drop policy if exists bi_arquivo_acessos_select on public.bi_arquivo_acessos;
create policy bi_arquivo_acessos_select on public.bi_arquivo_acessos for select to authenticated
  using (user_id = auth.uid() or public.bi_gerencia_arquivos());

drop policy if exists bi_arquivo_acessos_admin on public.bi_arquivo_acessos;
create policy bi_arquivo_acessos_admin on public.bi_arquivo_acessos for all to authenticated
  using (public.bi_gerencia_arquivos()) with check (public.bi_gerencia_arquivos());

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
  with check (bucket_id = 'bi-arquivos' and public.bi_gerencia_arquivos());

drop policy if exists bi_arquivos_obj_update on storage.objects;
create policy bi_arquivos_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'bi-arquivos' and public.bi_gerencia_arquivos());

drop policy if exists bi_arquivos_obj_delete on storage.objects;
create policy bi_arquivos_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bi-arquivos' and public.bi_gerencia_arquivos());

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
-- 7. POSITION (painéis desenhados pelo próprio portal)
-- O ADM ou File manager sobe a planilha diária "Brascof Position Overview";
-- o portal lê no navegador e grava aqui, de uma vez, pela função
-- bi_position_publicar. Os painéis são cadastrados em bi_dashboards com
-- link "portal:position-..." e o acesso segue bi_acessos, como os demais.
-- ---------------------------------------------------------------------
-- Uma linha por publicação: resumo (posição por mês, física, variação) — fica
-- o histórico para os gráficos de evolução
create table if not exists public.bi_position_cargas (
  id            bigint generated always as identity primary key,
  data_ref      date not null,                     -- "updated as of" da planilha
  nome_arquivo  text not null,
  resumo        jsonb not null,
  enviado_por   text,
  created_by    uuid default auth.uid() references public.bi_perfis (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists bi_position_cargas_data_idx on public.bi_position_cargas (data_ref desc, id desc);

-- Contratos em aberto da última publicação (substituídos a cada upload)
create table if not exists public.bi_position_detalhe (
  tipo        text primary key,                    -- purchases | expsales | intsales | inventory
  carga_id    bigint references public.bi_position_cargas (id) on delete cascade,
  linhas      jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Usuário vê algum painel ativo cujo link contém `trecho`? (ADM vê todos)
create or replace function public.bi_ve_painel(trecho text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.bi_is_admin() or (public.bi_is_ativo() and exists (
    select 1 from public.bi_acessos a join public.bi_dashboards d on d.id = a.dashboard_id
    where a.user_id = auth.uid() and d.ativo and d.link ilike '%' || trecho || '%'
  ));
$$;

alter table public.bi_position_cargas  enable row level security;
alter table public.bi_position_detalhe enable row level security;

-- Resumo: quem vê qualquer painel do Position. Detalhes: cada conjunto só para
-- quem vê o painel que o usa (contratos em aberto, histórico de vendas, de compras).
drop policy if exists bi_position_cargas_select on public.bi_position_cargas;
create policy bi_position_cargas_select on public.bi_position_cargas for select to authenticated
  using (public.bi_ve_painel('portal:position-') or public.bi_gerencia_arquivos());

drop policy if exists bi_position_detalhe_select on public.bi_position_detalhe;
create policy bi_position_detalhe_select on public.bi_position_detalhe for select to authenticated
  using (
    public.bi_gerencia_arquivos()
    -- histórico de vendas: Export Sales e Export Sale Diffs
    or (tipo = 'vendas' and (public.bi_ve_painel('portal:position-sales') or public.bi_ve_painel('portal:position-diffs')))
    or (tipo = 'compras' and public.bi_ve_painel('portal:position-purchases'))
    or (tipo not in ('vendas', 'compras') and public.bi_ve_painel('portal:position-contracts'))
  );
-- (gravação só pela função abaixo)

-- versão antiga (sem o alerta de fixação)
drop function if exists public.bi_position_publicar(date, text, jsonb, jsonb);

-- p_alerta: texto do alerta de fixação (contratos vencidos ou a vencer); vira
-- notificação para quem vê o painel Open Contracts
create or replace function public.bi_position_publicar(p_data_ref date, p_nome text, p_resumo jsonb, p_detalhes jsonb, p_alerta text default null)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_id bigint;
  v_tipo text;
begin
  if not public.bi_gerencia_arquivos() then
    raise exception 'Access denied';
  end if;
  insert into public.bi_position_cargas (data_ref, nome_arquivo, resumo, enviado_por)
  values (p_data_ref, p_nome, p_resumo,
          (select nullif(split_part(nome, ' ', 1), '') from public.bi_perfis where id = auth.uid()))
  returning id into v_id;

  for v_tipo in select jsonb_object_keys(p_detalhes) loop
    insert into public.bi_position_detalhe (tipo, carga_id, linhas, updated_at)
    values (v_tipo, v_id, p_detalhes -> v_tipo, now())
    on conflict (tipo) do update set carga_id = excluded.carga_id, linhas = excluded.linhas, updated_at = now();
  end loop;

  -- marca os painéis como atualizados; só o Overview gera notificação
  perform set_config('bi.sem_notificacao', '1', true);
  update public.bi_dashboards set atualizado_em = now()
   where link like 'portal:position-%' and link <> 'portal:position-overview';
  perform set_config('bi.sem_notificacao', '', true);
  update public.bi_dashboards set atualizado_em = now() where link = 'portal:position-overview';

  if nullif(trim(p_alerta), '') is not null then
    insert into public.bi_notificacoes (dashboard_id, titulo, mensagem)
    select id, 'Fixation alert', left(p_alerta, 300) from public.bi_dashboards where link = 'portal:position-contracts';
  end if;
  return v_id;
end;
$$;

revoke all on function public.bi_position_publicar(date, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.bi_position_publicar(date, text, jsonb, jsonb, text) to authenticated;

-- Categoria "Position" e os três painéis (só cria o que ainda não existe;
-- depois libere o acesso de cada usuário na Administração)
insert into public.bi_categorias (nome, ordem)
select 'Position', 0
where not exists (select 1 from public.bi_categorias where nome = 'Position');

insert into public.bi_dashboards (categoria_id, titulo, descricao, link, frequencia, ativo, ordem)
select c.id, v.titulo, v.descricao, v.link, 'diaria', true, v.ordem
from public.bi_categorias c,
     (values
       ('Position Overview', 'Net position by term month and change vs the previous position — Arabica, Robusta, Exportable and Low Grade.', 'portal:position-overview', 1),
       ('Physical Position', 'Physical position by month and running balance by quality.', 'portal:position-physical', 2),
       ('Open Contracts', 'Open purchases, export and domestic sales, and inventory, contract by contract.', 'portal:position-contracts', 3),
       ('Export Sales', 'Shipped volume, revenue and sale diff, crop over crop, by client and quality.', 'portal:position-sales', 4),
       ('Purchases', 'Purchased volume, value and purchase diff, crop over crop, by supplier and quality.', 'portal:position-purchases', 5),
       ('Export Sale Diffs', 'Average sale diff by month and quality, by inclusion date or EOM Ship.', 'portal:position-diffs', 6)
     ) as v (titulo, descricao, link, ordem)
where c.nome = 'Position'
  and not exists (select 1 from public.bi_dashboards d where d.link = v.link);

-- ---------------------------------------------------------------------
-- 9. POSITION PELA API DO DIGISUL
-- A sincronização (brascof-api, /api/position-sync) busca as consultas do
-- Digisul, executa as fórmulas da planilha (o "modelo", guardado a cada
-- upload) e grava aqui com fonte = 'api'. A planilha continua gravando com
-- fonte = 'planilha'; bi_config.position_fonte diz qual das duas os painéis
-- mostram. Pré-requisito: seção 7.
-- ---------------------------------------------------------------------
alter table public.bi_position_cargas add column if not exists fonte text not null default 'planilha';
alter table public.bi_position_cargas drop constraint if exists bi_position_cargas_fonte_check;
alter table public.bi_position_cargas add constraint bi_position_cargas_fonte_check check (fonte in ('planilha', 'api'));
-- a API grava várias vezes por dia: fica só a última de cada dia
create unique index if not exists bi_position_cargas_api_dia on public.bi_position_cargas (data_ref) where fonte = 'api';

alter table public.bi_position_detalhe add column if not exists fonte text not null default 'planilha';
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'bi_position_detalhe_pkey'
             and array_length(conkey, 1) = 1) then
    alter table public.bi_position_detalhe drop constraint bi_position_detalhe_pkey;
    alter table public.bi_position_detalhe add primary key (fonte, tipo);
  end if;
end $$;

-- Modelo da planilha (fórmulas das abas de resumo, títulos das abas base, tabela
-- List) + as operações de futuros da aba OpenFutures, que não existem na API.
create table if not exists public.bi_position_modelo (
  id            int primary key default 1 check (id = 1),
  modelo        jsonb not null,
  nome_arquivo  text,
  enviado_por   text,
  atualizado_em timestamptz not null default now()
);
alter table public.bi_position_modelo enable row level security;
drop policy if exists bi_position_modelo_select on public.bi_position_modelo;
create policy bi_position_modelo_select on public.bi_position_modelo for select to authenticated
  using (public.bi_gerencia_arquivos());

-- Configurações simples do portal (chave → valor)
create table if not exists public.bi_config (
  chave         text primary key,
  valor         jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.bi_config enable row level security;
drop policy if exists bi_config_select on public.bi_config;
create policy bi_config_select on public.bi_config for select to authenticated using (public.bi_is_ativo());
insert into public.bi_config (chave, valor) values ('position_fonte', '"planilha"') on conflict (chave) do nothing;

-- Upload da planilha: igual ao anterior, agora gravando os contratos com fonte = 'planilha'
create or replace function public.bi_position_publicar(p_data_ref date, p_nome text, p_resumo jsonb, p_detalhes jsonb, p_alerta text default null)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_id bigint;
  v_tipo text;
begin
  if not public.bi_gerencia_arquivos() then
    raise exception 'Access denied';
  end if;
  insert into public.bi_position_cargas (data_ref, nome_arquivo, resumo, enviado_por)
  values (p_data_ref, p_nome, p_resumo,
          (select nullif(split_part(nome, ' ', 1), '') from public.bi_perfis where id = auth.uid()))
  returning id into v_id;

  for v_tipo in select jsonb_object_keys(p_detalhes) loop
    insert into public.bi_position_detalhe (fonte, tipo, carga_id, linhas, updated_at)
    values ('planilha', v_tipo, v_id, p_detalhes -> v_tipo, now())
    on conflict (fonte, tipo) do update set carga_id = excluded.carga_id, linhas = excluded.linhas, updated_at = now();
  end loop;

  -- painéis e notificações só acompanham a fonte que está valendo
  if (select valor #>> '{}' from public.bi_config where chave = 'position_fonte') is distinct from 'api' then
    perform set_config('bi.sem_notificacao', '1', true);
    update public.bi_dashboards set atualizado_em = now()
     where link like 'portal:position-%' and link <> 'portal:position-overview';
    perform set_config('bi.sem_notificacao', '', true);
    update public.bi_dashboards set atualizado_em = now() where link = 'portal:position-overview';

    if nullif(trim(p_alerta), '') is not null then
      insert into public.bi_notificacoes (dashboard_id, titulo, mensagem)
      select id, 'Fixation alert', left(p_alerta, 300) from public.bi_dashboards where link = 'portal:position-contracts';
    end if;
  end if;
  return v_id;
end;
$$;

-- Modelo e futuros: gravados a cada upload da planilha
create or replace function public.bi_position_salvar_modelo(p_modelo jsonb, p_nome text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.bi_gerencia_arquivos() then
    raise exception 'Access denied';
  end if;
  insert into public.bi_position_modelo (id, modelo, nome_arquivo, enviado_por, atualizado_em)
  values (1, p_modelo, p_nome, (select nullif(split_part(nome, ' ', 1), '') from public.bi_perfis where id = auth.uid()), now())
  on conflict (id) do update set modelo = excluded.modelo, nome_arquivo = excluded.nome_arquivo,
    enviado_por = excluded.enviado_por, atualizado_em = now();
end;
$$;
revoke all on function public.bi_position_salvar_modelo(jsonb, text) from public, anon;
grant execute on function public.bi_position_salvar_modelo(jsonb, text) to authenticated;

-- Resultado da API: só o servidor (chave service_role) grava. Uma carga por dia,
-- atualizada a cada sincronização; notifica só quando a API é a fonte oficial,
-- e no máximo uma vez por dia.
create or replace function public.bi_position_publicar_api(p_data_ref date, p_resumo jsonb, p_detalhes jsonb, p_origem text, p_alerta text default null)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_id bigint;
  v_tipo text;
  v_novo_dia boolean;
begin
  v_novo_dia := not exists (select 1 from public.bi_position_cargas where fonte = 'api' and data_ref = p_data_ref);
  insert into public.bi_position_cargas (data_ref, nome_arquivo, resumo, enviado_por, fonte, created_by)
  values (p_data_ref, 'Digisul API', p_resumo, p_origem, 'api', null)
  on conflict (data_ref) where fonte = 'api'
  do update set resumo = excluded.resumo, enviado_por = excluded.enviado_por, created_at = now()
  returning id into v_id;

  for v_tipo in select jsonb_object_keys(p_detalhes) loop
    insert into public.bi_position_detalhe (fonte, tipo, carga_id, linhas, updated_at)
    values ('api', v_tipo, v_id, p_detalhes -> v_tipo, now())
    on conflict (fonte, tipo) do update set carga_id = excluded.carga_id, linhas = excluded.linhas, updated_at = now();
  end loop;

  if (select valor #>> '{}' from public.bi_config where chave = 'position_fonte') = 'api' then
    perform set_config('bi.sem_notificacao', '1', true);
    update public.bi_dashboards set atualizado_em = now() where link like 'portal:position-%';
    perform set_config('bi.sem_notificacao', '', true);
    if v_novo_dia then
      update public.bi_dashboards set atualizado_em = now() where link = 'portal:position-overview';
      if nullif(trim(p_alerta), '') is not null then
        insert into public.bi_notificacoes (dashboard_id, titulo, mensagem)
        select id, 'Fixation alert', left(p_alerta, 300) from public.bi_dashboards where link = 'portal:position-contracts';
      end if;
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.bi_position_publicar_api(date, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.bi_position_publicar_api(date, jsonb, jsonb, text, text) to service_role;

-- Qual fonte os painéis mostram (só ADM troca)
create or replace function public.bi_position_definir_fonte(p_fonte text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.bi_is_admin() then
    raise exception 'Access denied';
  end if;
  if p_fonte not in ('planilha', 'api') then
    raise exception 'Invalid source';
  end if;
  insert into public.bi_config (chave, valor, atualizado_em) values ('position_fonte', to_jsonb(p_fonte), now())
  on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
end;
$$;
revoke all on function public.bi_position_definir_fonte(text) from public, anon;
grant execute on function public.bi_position_definir_fonte(text) to authenticated;

-- (o agendamento está na seção 10)

-- ---------------------------------------------------------------------
-- 10. AGENDAMENTO DA ATUALIZAÇÃO PELO DIGISUL
-- De 2 em 2 horas, das 7h às 19h (horário de Brasília), de segunda a sexta.
-- O Supabase chama a brascof-api com um segredo gerado aqui mesmo e guardado
-- no Vault; a brascof-api confere o segredo pela função abaixo. Ninguém
-- precisa copiar senha. Pré-requisito: seção 9. Pode rodar de novo à vontade.
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'position_cron_secret') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'position_cron_secret',
                                'Chamada agendada da brascof-api /api/position-sync');
  end if;
end $$;

-- A brascof-api (chave service_role) pergunta se o segredo recebido confere
create or replace function public.bi_position_confere_cron(p_segredo text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'position_cron_secret' and decrypted_secret = p_segredo);
$$;
revoke all on function public.bi_position_confere_cron(text) from public, anon, authenticated;
grant execute on function public.bi_position_confere_cron(text) to service_role;

select cron.schedule('position-sync', '0 10,12,14,16,18,20,22 * * 1-5', $job$
  select net.http_post(
    url := 'https://brascof-api.vercel.app/api/position-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'position_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);

-- Para conferir as execuções:
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content::text from net._http_response order by created desc limit 5;

-- ---------------------------------------------------------------------
-- 8. PRIMEIRO ADMINISTRADOR
-- Use um usuário que já exista em Authentication > Users (pode ser o
-- mesmo login que você usa nos outros sistemas). Troque o e-mail e rode:
--
--   insert into public.bi_perfis (id, nome, email, is_admin)
--   select id, 'João Otavio Souza', email, true
--   from auth.users where email = 'jsouza@brascof.com'
--   on conflict (id) do update set is_admin = true, ativo = true;
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 11. CERTIFICADOS (página "Certificado CP" — C.A.F.E. Practices)
-- A sincronização pelo Digisul (seção 9) grava em bi_position_detalhe, com
-- fonte = 'api', os tipos cert_compras e cert_vendas: todas as compras e
-- exportações (histórico completo, poucos campos). A página separa as que têm
-- o certificado (ex.: "CP" ou "CAFE PRATICES" no certificador, mesmo junto com
-- outros) e soma os ajustes manuais abaixo. Pré-requisito: seções 7 e 9.
-- ---------------------------------------------------------------------
-- Ajustes manuais: incluir o certificado num contrato que o Digisul não deixa
-- mais editar (já encerrado), ou tirar um contrato que veio com o certificado.
create table if not exists public.bi_cert_ajustes (
  id           bigint generated always as identity primary key,
  certificado  text not null default 'CP',
  tipo         text not null check (tipo in ('compra', 'venda')),
  contrato     text not null,
  acao         text not null default 'incluir' check (acao in ('incluir', 'excluir')),
  sacas        numeric,                             -- null = contrato inteiro
  obs          text,
  autor        text,
  created_by   uuid default auth.uid() references public.bi_perfis (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (certificado, tipo, contrato)
);

-- quem lançou: sempre o usuário logado (não vem do navegador)
create or replace function public.bi_cert_autor()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.created_by := auth.uid();
  new.autor := (select nullif(nome, '') from public.bi_perfis where id = auth.uid());
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists bi_cert_ajustes_autor on public.bi_cert_ajustes;
create trigger bi_cert_ajustes_autor before insert or update on public.bi_cert_ajustes
  for each row execute function public.bi_cert_autor();

alter table public.bi_cert_ajustes enable row level security;
-- vê quem vê a página; lança e remove quem publica no portal (ADM ou File manager)
drop policy if exists bi_cert_ajustes_select on public.bi_cert_ajustes;
create policy bi_cert_ajustes_select on public.bi_cert_ajustes for select to authenticated
  using (public.bi_ve_painel('portal:cert-') or public.bi_gerencia_arquivos());
drop policy if exists bi_cert_ajustes_insert on public.bi_cert_ajustes;
create policy bi_cert_ajustes_insert on public.bi_cert_ajustes for insert to authenticated
  with check (public.bi_gerencia_arquivos());
drop policy if exists bi_cert_ajustes_update on public.bi_cert_ajustes;
create policy bi_cert_ajustes_update on public.bi_cert_ajustes for update to authenticated
  using (public.bi_gerencia_arquivos()) with check (public.bi_gerencia_arquivos());
drop policy if exists bi_cert_ajustes_delete on public.bi_cert_ajustes;
create policy bi_cert_ajustes_delete on public.bi_cert_ajustes for delete to authenticated
  using (public.bi_gerencia_arquivos());

-- Substitui a política da seção 7: a base dos certificados é de quem vê a página
drop policy if exists bi_position_detalhe_select on public.bi_position_detalhe;
create policy bi_position_detalhe_select on public.bi_position_detalhe for select to authenticated
  using (
    public.bi_gerencia_arquivos()
    or (tipo = 'vendas' and (public.bi_ve_painel('portal:position-sales') or public.bi_ve_painel('portal:position-diffs')))
    or (tipo = 'compras' and public.bi_ve_painel('portal:position-purchases'))
    or (tipo like 'cert\_%' and public.bi_ve_painel('portal:cert-'))
    or (tipo not in ('vendas', 'compras') and tipo not like 'cert\_%' and public.bi_ve_painel('portal:position-contracts'))
  );

-- Igual à da seção 9, marcando também as páginas de certificado como atualizadas
-- (a base delas só vem da API, qualquer que seja a fonte oficial do Position)
create or replace function public.bi_position_publicar_api(p_data_ref date, p_resumo jsonb, p_detalhes jsonb, p_origem text, p_alerta text default null)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_id bigint;
  v_tipo text;
  v_novo_dia boolean;
begin
  v_novo_dia := not exists (select 1 from public.bi_position_cargas where fonte = 'api' and data_ref = p_data_ref);
  insert into public.bi_position_cargas (data_ref, nome_arquivo, resumo, enviado_por, fonte, created_by)
  values (p_data_ref, 'Digisul API', p_resumo, p_origem, 'api', null)
  on conflict (data_ref) where fonte = 'api'
  do update set resumo = excluded.resumo, enviado_por = excluded.enviado_por, created_at = now()
  returning id into v_id;

  for v_tipo in select jsonb_object_keys(p_detalhes) loop
    insert into public.bi_position_detalhe (fonte, tipo, carga_id, linhas, updated_at)
    values ('api', v_tipo, v_id, p_detalhes -> v_tipo, now())
    on conflict (fonte, tipo) do update set carga_id = excluded.carga_id, linhas = excluded.linhas, updated_at = now();
  end loop;

  if p_detalhes ? 'cert_compras' then
    perform set_config('bi.sem_notificacao', '1', true);
    update public.bi_dashboards set atualizado_em = now() where link like 'portal:cert-%';
    perform set_config('bi.sem_notificacao', '', true);
  end if;

  if (select valor #>> '{}' from public.bi_config where chave = 'position_fonte') = 'api' then
    perform set_config('bi.sem_notificacao', '1', true);
    update public.bi_dashboards set atualizado_em = now() where link like 'portal:position-%';
    perform set_config('bi.sem_notificacao', '', true);
    if v_novo_dia then
      update public.bi_dashboards set atualizado_em = now() where link = 'portal:position-overview';
      if nullif(trim(p_alerta), '') is not null then
        insert into public.bi_notificacoes (dashboard_id, titulo, mensagem)
        select id, 'Fixation alert', left(p_alerta, 300) from public.bi_dashboards where link = 'portal:position-contracts';
      end if;
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.bi_position_publicar_api(date, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.bi_position_publicar_api(date, jsonb, jsonb, text, text) to service_role;

-- Categoria "Certificates" e a página do CP (depois libere o acesso na Administração)
insert into public.bi_categorias (nome, ordem)
select 'Certificates', 1
where not exists (select 1 from public.bi_categorias where nome = 'Certificates');

insert into public.bi_dashboards (categoria_id, titulo, descricao, link, frequencia, ativo, ordem)
select c.id, 'C.A.F.E. Practices (CP)', 'Long/short position of the CP certificate by month, with the certified purchases and export sales, contract by contract.',
       'portal:cert-cp', 'diaria', true, 1
from public.bi_categorias c
where c.nome = 'Certificates'
  and not exists (select 1 from public.bi_dashboards d where d.link = 'portal:cert-cp');