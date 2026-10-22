-- MoneyMap sync reliability migration
-- Run this once in Supabase SQL Editor for an existing MoneyMap project.
-- It adds optimistic concurrency control and a private atomic save function.
-- It does not delete or replace your existing payload data.

alter table public.moneymap_sync
  add column if not exists revision bigint not null default 1;

revoke all privileges on table public.moneymap_sync from anon;
grant select, insert, update on table public.moneymap_sync to authenticated;

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
