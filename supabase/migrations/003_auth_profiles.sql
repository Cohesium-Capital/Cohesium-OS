-- 003_auth_profiles.sql
-- Multi-user auth + role-based RLS. schema.sql is the 001 baseline.
--
-- One profile row per Supabase auth user, carrying a role. RLS is turned on for
-- every data table and gated on that role. v1: 'admin'/'member' get full access,
-- 'partner' gets none (its scoping rules are defined later). The Python worker
-- tier uses the service_role key, which bypasses RLS entirely, so existing
-- scripts (extract.py) are unaffected.

create table if not exists public.profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    email       text,
    full_name   text,
    role        text not null default 'member'
                  check (role in ('admin', 'member', 'partner')),
    created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Current user's role, read without tripping RLS recursion (SECURITY DEFINER
-- bypasses RLS on profiles). Named user_role() to avoid clashing with the
-- built-in current_role.
create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- A user sees their own profile; admins see all.
drop policy if exists "profiles self or admin read" on public.profiles;
create policy "profiles self or admin read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.user_role() = 'admin');

-- Admins can update any profile (e.g. grant a role); users may update their own
-- non-role fields. Role changes are intended to be admin-only; enforce in app.
drop policy if exists "profiles admin write" on public.profiles;
create policy "profiles admin write" on public.profiles
  for all to authenticated
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- Auto-create a profile when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Data tables: enable RLS and grant full access to admin/member only.
do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations', 'contacts', 'touches',
    'interactions', 'extractions', 'intro_paths'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "members full access" on public.%I;', t);
    execute format(
      'create policy "members full access" on public.%I for all to authenticated '
      || 'using (public.user_role() in (''admin'', ''member'')) '
      || 'with check (public.user_role() in (''admin'', ''member''));',
      t
    );
  end loop;
end $$;
