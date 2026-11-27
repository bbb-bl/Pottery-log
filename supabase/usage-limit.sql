-- Pottery Log: daily limit for "Name it for me" (20 per person per day)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
-- No policies on purpose: the app itself can't read or change this table, only the server function.

create or replace function public.ai_take(p_user uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare c int;
begin
  insert into public.ai_usage (user_id, day, count)
  values (p_user, (now() at time zone 'Europe/Budapest')::date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into c;
  delete from public.ai_usage where day < (now() at time zone 'Europe/Budapest')::date - 7;
  return c;
end $$;

revoke execute on function public.ai_take(uuid) from public, anon, authenticated;
grant execute on function public.ai_take(uuid) to service_role;
