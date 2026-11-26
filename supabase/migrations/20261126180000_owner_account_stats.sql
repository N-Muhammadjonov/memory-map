-- Owner authorization is server-side. Configure the verified account separately.
-- No identity or privileged secret is committed with this migration.
create schema if not exists memory_map_private;
revoke all on schema memory_map_private from public, anon, authenticated;
grant usage on schema memory_map_private to authenticated;

create table if not exists memory_map_private.owner_accounts (
    email text primary key check (email = lower(trim(email)))
);
alter table memory_map_private.owner_accounts enable row level security;
revoke all on memory_map_private.owner_accounts from public, anon, authenticated;

create or replace function memory_map_private.owner_account_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    caller uuid := auth.uid();
    access_session text := auth.jwt() ->> 'session_id';
    result jsonb;
begin
    -- Read verified identity and the live server-side session, not user-editable metadata.
    if caller is null or access_session is null or not exists (
        select 1
        from auth.users u
        join memory_map_private.owner_accounts o on o.email = lower(u.email)
        join auth.sessions s on s.user_id = u.id
        where u.id = caller
          and u.email_confirmed_at is not null
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= now())
          and s.id::text = access_session
          and (s.not_after is null or s.not_after > now())
    ) then
        return jsonb_build_object('owner', false);
    end if;

    select jsonb_build_object(
        'owner', true,
        'registered', count(*),
        'confirmed', count(*) filter (where email_confirmed_at is not null),
        'newLast7', count(*) filter (where created_at >= now() - interval '7 days'),
        'signedInLast30', count(*) filter (where last_sign_in_at >= now() - interval '30 days')
    ) into result
    from auth.users
    where deleted_at is null and email is not null;
    return result;
end;
$$;
revoke all on function memory_map_private.owner_account_stats() from public, anon, authenticated;
grant execute on function memory_map_private.owner_account_stats() to authenticated;

create or replace function public.owner_account_stats()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select memory_map_private.owner_account_stats();
$$;
revoke all on function public.owner_account_stats() from public, anon, authenticated;
grant execute on function public.owner_account_stats() to authenticated;
