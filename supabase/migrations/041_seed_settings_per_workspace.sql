-- 041_seed_settings_per_workspace.sql
--
-- Gate settings rows were only ever seeded by migration 010, for the original
-- (operator's) workspace. create_workspace() seeded nothing, so a new tenant
-- had NO settings rows: the Settings form's update matched zero rows and
-- reported success while every gate ran on the hardcoded code fallbacks —
-- including sample_rate 1.0, i.e. grading 100% of every batch.
--
-- The app-side updateGateSettings is now an upsert, so a save works either
-- way; this migration makes the rows exist up front so the Settings page
-- SHOWS a new workspace its actual thresholds instead of an empty panel.

-- 1. Backfill: every workspace gets the 010 defaults for any module it lacks.
insert into public.settings (workspace_id, module, gate_threshold, sample_rate, min_sample_size)
select w.id, d.module, d.gate_threshold, d.sample_rate, d.min_sample_size
  from public.workspaces w
 cross join (values
    ('sourcing',        0.20, 1.0, 20),
    ('enrichment',      0.25, 1.0, 20),
    ('personalization', 0.25, 1.0, 20),
    ('drafting',        0.25, 1.0, 20)
  ) as d(module, gate_threshold, sample_rate, min_sample_size)
 on conflict (workspace_id, module) do nothing;

-- 2. create_workspace() seeds the same defaults for every future tenant.
--    Body otherwise identical to 033's definition (name-trim guard, admin
--    membership, default-workspace rule).
create or replace function public.create_workspace(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  clean  text := nullif(btrim(workspace_name), '');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if clean is null then
    raise exception 'a workspace needs a name';
  end if;

  insert into public.workspaces (name) values (clean) returning id into new_id;

  -- The creator is an admin, and this is their default only if they have no
  -- other default — switching workspaces should not silently move someone's
  -- landing place.
  insert into public.workspace_members (workspace_id, user_id, role, is_default)
  values (
    new_id,
    auth.uid(),
    'admin',
    not exists (select 1 from public.workspace_members m
                 where m.user_id = auth.uid() and m.is_default)
  );

  -- Per-module gate settings, at the same defaults 010 seeded: a workspace
  -- with no settings rows runs its gates on invisible code fallbacks.
  insert into public.settings (workspace_id, module, gate_threshold, sample_rate, min_sample_size)
  values
    (new_id, 'sourcing',        0.20, 1.0, 20),
    (new_id, 'enrichment',      0.25, 1.0, 20),
    (new_id, 'personalization', 0.25, 1.0, 20),
    (new_id, 'drafting',        0.25, 1.0, 20);

  return new_id;
end;
$$;

revoke all on function public.create_workspace(text) from public;
grant execute on function public.create_workspace(text) to authenticated;

-- 3. approve_access_request() mints tenants too (directly, not through
--    create_workspace — it acts for the REQUESTER'S user_id, not auth.uid()),
--    so it seeds the same settings rows. While redefining it, the request row
--    is now read FOR UPDATE: without the lock, two concurrent approvals (two
--    operators, or a double-submit racing past the client's disabled state)
--    both saw status='pending' and each minted a workspace — the exact
--    double-tenant the idempotency check exists to prevent, with the loser's
--    workspace left orphaned. Body otherwise identical to 038's definition.
create or replace function public.approve_access_request(
  p_request_id uuid,
  p_workspace_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  req    public.access_requests;
  new_id uuid;
  clean  text := nullif(btrim(p_workspace_name), '');
begin
  if not public.is_instance_operator() then
    raise exception 'only the operator can approve access requests';
  end if;

  -- FOR UPDATE: exactly one approval wins; the loser blocks here and then
  -- takes the idempotent branch below.
  select * into req from public.access_requests where id = p_request_id for update;
  if req is null then
    raise exception 'no such access request';
  end if;
  if req.status = 'approved' then
    -- Idempotent rather than an error: a double-click must not mint a second
    -- tenant for the same person.
    return req.workspace_id;
  end if;

  if clean is null then
    clean := coalesce(nullif(btrim(req.firm_name), ''), split_part(req.email, '@', 2));
  end if;

  insert into public.workspaces (name) values (clean) returning id into new_id;

  insert into public.workspace_members (workspace_id, user_id, role, is_default)
  values (new_id, req.user_id, 'admin',
          not exists (select 1 from public.workspace_members m
                       where m.user_id = req.user_id and m.is_default));

  insert into public.settings (workspace_id, module, gate_threshold, sample_rate, min_sample_size)
  values
    (new_id, 'sourcing',        0.20, 1.0, 20),
    (new_id, 'enrichment',      0.25, 1.0, 20),
    (new_id, 'personalization', 0.25, 1.0, 20),
    (new_id, 'drafting',        0.25, 1.0, 20);

  update public.access_requests
     set status = 'approved',
         decided_at = now(),
         decided_by = auth.uid(),
         workspace_id = new_id
   where id = p_request_id;

  return new_id;
end;
$$;

revoke all on function public.approve_access_request(uuid, text) from public;
grant execute on function public.approve_access_request(uuid, text) to authenticated;
