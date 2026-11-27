-- Pottery Log: saved Vase Designer forms, one row per design, private to each user
create table if not exists public.designs (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.designs enable row level security;
create policy "own designs" on public.designs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
