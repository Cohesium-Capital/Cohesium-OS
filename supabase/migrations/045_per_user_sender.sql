-- 045_per_user_sender.sql
--
-- The sender of an outreach message should be the PERSON who sent it, not the
-- firm. Two gaps stood in the way, both fixed here:
--
--   1. touches.created_by never existed as a column, yet the email cron already
--      SELECTs it (app/api/cron/email/route.ts) and keys the per-user From:
--      identity on it. So the email send path was erroring in production. Add
--      the column; storeDrafts now stamps it with the drafting user.
--
--   2. The drafted BODY sign-off / intro were workspace-level (one value per
--      tenant, migration 032). member_sender lets a user set their OWN sign-off
--      name and intro within a tenant; when unset, resolution falls back to the
--      user's sending-identity name / profile name, then the admin-set workspace
--      default. The admin default still lives in workspace_profile.
--
-- Additive and idempotent.

-- ---------- 1. who authored a touch ----------

alter table public.touches
  add column if not exists created_by uuid references auth.users(id);

create index if not exists touches_created_by_idx on public.touches (created_by);

-- ---------- 2. per-user, per-workspace sender override ----------

create table if not exists public.member_sender (
    workspace_id uuid not null references public.workspaces(id) on delete cascade,
    user_id      uuid not null references auth.users(id) on delete cascade,
    -- Both nullable: a member may override just the sign-off name, just the
    -- intro, or neither (in which case they inherit the workspace default).
    sender_name  text,
    sender_intro text,
    updated_at   timestamptz not null default now(),
    updated_by   text,
    primary key (workspace_id, user_id)
);

alter table public.member_sender enable row level security;

-- A member manages ONLY their own override, and only in a workspace they belong
-- to. No admin write path: this is a personal setting, not an admin-assigned one
-- (the admin default is workspace_profile). Reads are self-only too, which is all
-- the drafting resolution needs — it loads the run creator's own row.
drop policy if exists "member manages own sender" on public.member_sender;
create policy "member manages own sender" on public.member_sender
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- ---------- verification ----------
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'touches' and column_name = 'created_by';

select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'member_sender'
 order by ordinal_position;
