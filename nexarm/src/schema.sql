create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  email text
);
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  role text not null check (role in ('lector','operador','admin')),
  on_behalf_of uuid not null references users(id),
  token_hash text not null unique,
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  domain text,
  created_at timestamptz not null default now()
);
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  company_id uuid references companies(id),
  name text not null,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  unique (tenant_id, name)
);
create table if not exists stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  pipeline_id uuid not null references pipelines(id),
  name text not null,
  position int not null,
  unique (pipeline_id, name)
);
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  pipeline_id uuid not null references pipelines(id),
  stage_id uuid not null references stages(id),
  contact_id uuid references contacts(id),
  company_id uuid references companies(id),
  title text not null,
  amount numeric(14,2),
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contact_id uuid references contacts(id),
  deal_id uuid references deals(id),
  kind text not null check (kind in ('nota','llamada','correo','reunion','mensaje')),
  body text not null,
  created_at timestamptz not null default now()
);

alter table agents add column if not exists expires_at timestamptz;

-- Permiso fino: permite o deniega una herramienta a un agente, por encima de su rol.
create table if not exists agent_grants (
  agent_id uuid not null references agents(id),
  tenant_id uuid not null references tenants(id),
  tool text not null,
  effect text not null check (effect in ('permitir','denegar')),
  primary key (agent_id, tool)
);

-- Politica: limite que la pasarela aplica antes de ejecutar. Sin agente o sin herramienta, aplica a todos.
create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  kind text not null check (kind in ('monto_maximo','limite_frecuencia','horario','campos_restringidos')),
  params jsonb not null,
  agent_id uuid references agents(id),
  tool text,
  applies_to text not null default 'escritura' check (applies_to in ('escritura','todas')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

-- Libro de auditoria: solo se agrega. Cada entrada lleva el hash de la anterior.
create table if not exists audit_log (
  seq bigserial primary key,
  tenant_id uuid not null references tenants(id),
  at timestamptz not null,
  agent_id uuid not null,
  agent_name text not null,
  user_id uuid not null,
  tool text not null,
  args jsonb not null,
  outcome text not null check (outcome in ('ejecutado','denegado','error')),
  detail jsonb not null,
  prev_hash text not null,
  hash text not null unique
);

create or replace function audit_log_inmutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log es de solo agregar: % no permitido', tg_op;
end $$;
create or replace trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_inmutable();
create or replace trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_inmutable();

-- Aislamiento por cliente: el rol de aplicacion solo ve filas de app.tenant_id.
do $$ begin
  if not exists (select from pg_roles where rolname = 'nexarm_app') then
    create role nexarm_app nologin;
  end if;
end $$;
grant select, insert, update on users, companies, contacts, pipelines, stages, deals, activities to nexarm_app;
grant select, insert, update on agents, policies to nexarm_app;
grant select, insert, update, delete on agent_grants to nexarm_app;
grant select, insert on audit_log to nexarm_app;
grant usage, select on sequence audit_log_seq_seq to nexarm_app;

do $$
declare t text;
begin
  foreach t in array array['users','agents','agent_grants','policies','companies','contacts','pipelines','stages','deals','activities','audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'')::uuid) with check (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  end loop;
end $$;

-- Personas: quien inicia sesion en la consola y quien puede aprobar.
alter table users add column if not exists role text not null default 'miembro' check (role in ('miembro','supervisor'));
alter table users add column if not exists login text unique;
alter table users add column if not exists password_hash text;

-- Con esto activo, un agente administrador propone cambios de gobierno y una persona los aprueba.
alter table tenants add column if not exists governance_approval boolean not null default true;

alter table audit_log add column if not exists actor text not null default 'agente' check (actor in ('agente','humano'));
alter table audit_log drop constraint if exists audit_log_outcome_check;
alter table audit_log add constraint audit_log_outcome_check check (outcome in ('ejecutado','denegado','error','pendiente'));
alter table policies drop constraint if exists policies_kind_check;
alter table policies add constraint policies_kind_check
  check (kind in ('monto_maximo','limite_frecuencia','horario','campos_restringidos','requiere_aprobacion'));

-- Aprobacion: una llamada detenida por la pasarela hasta que una persona decide.
create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  agent_id uuid not null references agents(id),
  tool text not null,
  args jsonb not null,
  restricted jsonb not null default '[]',
  reason text not null,
  policy text,
  status text not null default 'pendiente' check (status in ('pendiente','aprobada','rechazada','vencida','error')),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  decided_by uuid references users(id),
  decided_at timestamptz,
  note text,
  result jsonb
);

-- Sesiones de la consola y credenciales OAuth. Solo guardan hashes; el rol de aplicacion no las alcanza.
create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id),
  expires_at timestamptz not null
);
create table if not exists oauth_clients (
  client_id text primary key,
  info jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id),
  agent_id uuid not null references agents(id),
  challenge text not null,
  redirect_uri text not null,
  expires_at timestamptz not null
);
create table if not exists oauth_tokens (
  token_hash text primary key,
  kind text not null check (kind in ('acceso','refresco')),
  client_id text not null references oauth_clients(client_id),
  agent_id uuid not null references agents(id),
  expires_at timestamptz not null
);

grant select, insert, update on approvals to nexarm_app;
grant select on tenants to nexarm_app;
alter table approvals enable row level security;
drop policy if exists tenant_isolation on approvals;
create policy tenant_isolation on approvals using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
alter table tenants enable row level security;
drop policy if exists tenant_isolation on tenants;
create policy tenant_isolation on tenants using (id = current_setting('app.tenant_id')::uuid);

-- Freno general: con esto activo, ningun agente del cliente ejecuta nada.
alter table tenants add column if not exists paused boolean not null default false;

-- Un contacto que pidio no ser contactado no recibe mensajes de ningun agente.
alter table contacts add column if not exists do_not_contact boolean not null default false;

-- Calificacion del prospecto: puntaje de 0 a 100 que pone un agente, con su motivo.
alter table contacts add column if not exists score int check (score between 0 and 100);
alter table contacts add column if not exists score_reason text;
alter table contacts add column if not exists scored_at timestamptz;

-- Lo necesario para deshacer una accion. Vive fuera del libro: guarda el estado previo sin enmascarar
-- y ninguna herramienta lo lee.
create table if not exists undo_snapshots (
  audit_seq bigint primary key,
  tenant_id uuid not null references tenants(id),
  tool text not null,
  args jsonb not null,
  before jsonb,
  result jsonb,
  reverted_at timestamptz,
  reverted_by uuid references users(id)
);
grant select, insert, update on undo_snapshots to nexarm_app;
grant delete on contacts, companies, deals, activities to nexarm_app;
alter table undo_snapshots enable row level security;
drop policy if exists tenant_isolation on undo_snapshots;
create policy tenant_isolation on undo_snapshots using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- Identificador del mensaje en el sistema de origen: una misma entrega no entra dos veces.
alter table activities add column if not exists external_id text;
create unique index if not exists activities_external_id on activities (tenant_id, external_id) where external_id is not null;
