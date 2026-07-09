-- ARIA cloud workspace schema (Stage 2).
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- The cloud is ONLY the identity + licence authority: who you are, which
-- workspace you belong to, what the workspace has paid for. Conversations,
-- documents and all business data stay on each machine (local-first).

-- ---------------------------------------------------------------- tables

create table if not exists public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  plan        text not null default 'free',
  status      text not null default 'active',      -- active | past_due | cancelled
  seat_limit  int  not null default 5,
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now()
);

create table if not exists public.memberships (
  org_id      uuid not null references public.organisations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('admin', 'staff')),
  name        text,
  status      text not null default 'active',      -- active | suspended
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations (id) on delete cascade,
  code        text not null unique,
  role        text not null check (role in ('admin', 'staff')),
  for_name    text,
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_by     uuid references auth.users (id),
  used_at     timestamptz
);

-- ---------------------------------------------------------------- helpers

-- SECURITY DEFINER so RLS policies can ask "is this caller an admin of org X"
-- without recursing into the memberships policies themselves.
create or replace function public.is_org_member (org uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from memberships
    where org_id = org and user_id = auth.uid() and status = 'active'
  );
$$;

create or replace function public.is_org_admin (org uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from memberships
    where org_id = org and user_id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

-- ---------------------------------------------------------------- RLS

alter table public.organisations enable row level security;
alter table public.memberships  enable row level security;
alter table public.invites      enable row level security;

drop policy if exists org_select on public.organisations;
create policy org_select on public.organisations
  for select using (public.is_org_member(id));

drop policy if exists org_admin_update on public.organisations;
create policy org_admin_update on public.organisations
  for update using (public.is_org_admin(id))
  -- plan/status/seat_limit are billing-owned (Stage 3 webhook, service role):
  with check (public.is_org_admin(id));

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select using (user_id = auth.uid() or public.is_org_admin(org_id));

drop policy if exists memberships_admin_write on public.memberships;
create policy memberships_admin_write on public.memberships
  for update using (public.is_org_admin(org_id));

drop policy if exists memberships_admin_delete on public.memberships;
create policy memberships_admin_delete on public.memberships
  for delete using (public.is_org_admin(org_id));

drop policy if exists invites_admin_all on public.invites;
create policy invites_admin_all on public.invites
  for all using (public.is_org_admin(org_id));

-- Note: there is deliberately NO insert policy on memberships/organisations —
-- rows are created only through the two functions below, which enforce the
-- rules (seat limits, valid codes) server-side.

-- ---------------------------------------------------------------- functions

-- Create a workspace: caller becomes its first admin.
create or replace function public.create_organisation (org_name text, admin_name text default null)
returns public.organisations
language plpgsql security definer set search_path = public as $$
declare
  org public.organisations;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  insert into organisations (name, created_by)
    values (trim(org_name), auth.uid())
    returning * into org;
  insert into memberships (org_id, user_id, role, name)
    values (org.id, auth.uid(), 'admin', nullif(trim(coalesce(admin_name, '')), ''));
  return org;
end;
$$;

-- Redeem an invite code: joins the caller to the org (seat-limit checked).
create or replace function public.redeem_invite (invite_code text, member_name text default null)
returns table (org_id uuid, org_name text, role text)
language plpgsql security definer set search_path = public as $$
-- The OUT columns (org_id, role) collide with memberships' columns inside
-- ON CONFLICT; prefer the table columns there. All variable reads below are
-- qualified (inv.x / org.x), so this is unambiguous.
#variable_conflict use_column
declare
  inv  public.invites;
  org  public.organisations;
  used int;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select * into inv from invites
    where upper(replace(code, '-', '')) = upper(replace(invite_code, '-', ''))
    for update;
  if inv is null or inv.used_at is not null then
    raise exception 'That invite code is not valid — ask your administrator for a new one.';
  end if;
  if inv.expires_at < now() then
    raise exception 'That invite code has expired — ask your administrator for a new one.';
  end if;
  select * into org from organisations where id = inv.org_id;
  select count(*) into used from memberships where memberships.org_id = inv.org_id and status = 'active';
  if used >= org.seat_limit then
    raise exception 'This workspace has no free seats (% of % used) — the administrator can raise the plan.', used, org.seat_limit;
  end if;
  insert into memberships (org_id, user_id, role, name)
    values (inv.org_id, auth.uid(), inv.role, nullif(trim(coalesce(member_name, '')), ''))
    on conflict (org_id, user_id) do update set status = 'active', role = excluded.role;
  update invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  return query select org.id, org.name, inv.role;
end;
$$;

-- Admins mint invite codes server-side so codes are never guessable client picks.
create or replace function public.create_invite (org uuid, invite_role text, invite_for text default null)
returns public.invites
language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  chars constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  code text := '';
begin
  if not public.is_org_admin(org) then
    raise exception 'Only workspace admins can create invites.';
  end if;
  if invite_role not in ('admin', 'staff') then
    raise exception 'Role must be admin or staff.';
  end if;
  for i in 1..8 loop
    code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    if i = 4 then code := code || '-'; end if;
  end loop;
  insert into invites (org_id, code, role, for_name, created_by, expires_at)
    values (org, code, invite_role, nullif(trim(coalesce(invite_for, '')), ''), auth.uid(), now() + interval '7 days')
    returning * into inv;
  return inv;
end;
$$;

grant execute on function public.create_organisation (text, text) to authenticated;
grant execute on function public.redeem_invite (text, text)       to authenticated;
grant execute on function public.create_invite (uuid, text, text) to authenticated;
