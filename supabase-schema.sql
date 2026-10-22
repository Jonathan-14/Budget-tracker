-- MoneyMap single-user cloud sync table.
-- Run this in Supabase SQL Editor after creating your project.
-- This table is private to the authenticated user who owns each row.

create table if not exists public.moneymap_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.moneymap_sync enable row level security;

-- Remove broad policies if this script is run again, then apply owner-only rules.
drop policy if exists "Users can read their own MoneyMap data" on public.moneymap_sync;
drop policy if exists "Users can insert their own MoneyMap data" on public.moneymap_sync;
drop policy if exists "Users can update their own MoneyMap data" on public.moneymap_sync;

create policy "Users can read their own MoneyMap data"
  on public.moneymap_sync for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own MoneyMap data"
  on public.moneymap_sync for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own MoneyMap data"
  on public.moneymap_sync for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No anonymous access policies are created. Do not add service-role keys to the frontend.


-- Table privileges are required in addition to RLS policies.
revoke all privileges on table public.moneymap_sync from anon;
grant select, insert, update on table public.moneymap_sync to authenticated;

-- Atomically save only if the caller's revision is still current.
create or replace function public.moneymap_sync_save(
  p_payload jsonb,
  p_expected_revision bigint
)
returns table(saved boolean, current_revision bigint, current_updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_revision bigint;
  v_updated_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  insert into public.moneymap_sync (user_id, payload, revision, updated_at)
  values ((select auth.uid()), p_payload, 1, now())
  on conflict (user_id) do update
    set payload = excluded.payload,
        revision = public.moneymap_sync.revision + 1,
        updated_at = now()
    where public.moneymap_sync.revision = p_expected_revision
  returning revision, updated_at into v_revision, v_updated_at;

  if not found then
    return query
      select false, m.revision, m.updated_at
      from public.moneymap_sync as m
      where m.user_id = (select auth.uid());
    return;
  end if;

  return query select true, v_revision, v_updated_at;
end;
$$;

revoke all on function public.moneymap_sync_save(jsonb, bigint) from public, anon;
grant execute on function public.moneymap_sync_save(jsonb, bigint) to authenticated;
