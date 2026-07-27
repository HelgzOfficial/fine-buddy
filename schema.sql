-- ============================================================
-- FINE BUDDY — Supabase database setup
--
-- HOW TO RUN THIS:
-- 1. Open your project at https://supabase.com/dashboard
-- 2. Click "SQL Editor" in the left sidebar → "New query"
-- 3. Paste this ENTIRE file in and click "Run"
-- (It's safe to re-run — it won't duplicate anything.)
-- ============================================================

-- 1. Players — one row per person who signs in
create table if not exists public.players (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'New Player',
  photo_url text,
  is_admin boolean not null default false,
  season_paid numeric not null default 0,
  created_at timestamptz not null default now()
);

-- 2. The fines catalog (offense + price)
create table if not exists public.fines (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  price numeric not null default 0,
  created_at timestamptz not null default now()
);

-- 3. The log — every time a fine is actually issued to a player
create table if not exists public.fine_log (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  fine_id uuid references public.fines(id) on delete set null,
  label text not null,
  amount numeric not null,
  date date not null default current_date,
  paid boolean not null default false,
  created_at timestamptz not null default now()
);

-- 4. Announcements
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  date date not null default current_date,
  created_at timestamptz not null default now()
);

-- 5. Social calendar events
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  date date not null,
  description text,
  link text,
  funds_note text,
  created_at timestamptz not null default now()
);

-- 6. Team info — always exactly one row (id = 1)
create table if not exists public.team_info (
  id int primary key default 1,
  name text not null default 'My Team',
  crest_url text,
  stripe_link text,
  bank_account_name text,
  bank_sort_code text,
  bank_account_number text,
  bank_reference text,
  double_bubble boolean not null default false,
  constraint single_row check (id = 1)
);
insert into public.team_info (id, name) values (1, 'My Team')
  on conflict (id) do nothing;

-- ============================================================
-- Helper: is the currently logged-in user an admin?
-- ============================================================
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select is_admin from public.players where id = auth.uid()), false);
$$;

-- ============================================================
-- Safety triggers — stop a regular player from editing things
-- they shouldn't be able to touch, even if someone pokes the API directly.
-- ============================================================
create or replace function public.players_guard()
returns trigger
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    new.is_admin := old.is_admin;         -- can't self-promote to admin
    new.season_paid := old.season_paid;   -- only admin/system can change this
  end if;
  return new;
end;
$$;
drop trigger if exists trg_players_guard on public.players;
create trigger trg_players_guard before update on public.players
  for each row execute function public.players_guard();

create or replace function public.fine_log_guard()
returns trigger
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    -- a non-admin may only flip "paid" on their own fine — nothing else
    new.player_id := old.player_id;
    new.fine_id := old.fine_id;
    new.label := old.label;
    new.amount := old.amount;
    new.date := old.date;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_fine_log_guard on public.fine_log;
create trigger trg_fine_log_guard before update on public.fine_log
  for each row execute function public.fine_log_guard();

-- Auto-create a players row the moment someone signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.players (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists trg_new_user on auth.users;
create trigger trg_new_user after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Row Level Security — who can read/write what
-- ============================================================
alter table public.players enable row level security;
alter table public.fines enable row level security;
alter table public.fine_log enable row level security;
alter table public.announcements enable row level security;
alter table public.events enable row level security;
alter table public.team_info enable row level security;

drop policy if exists "read players" on public.players;
create policy "read players" on public.players for select using (auth.role() = 'authenticated');
drop policy if exists "read fines" on public.fines;
create policy "read fines" on public.fines for select using (auth.role() = 'authenticated');
drop policy if exists "read fine_log" on public.fine_log;
create policy "read fine_log" on public.fine_log for select using (auth.role() = 'authenticated');
drop policy if exists "read announcements" on public.announcements;
create policy "read announcements" on public.announcements for select using (auth.role() = 'authenticated');
drop policy if exists "read events" on public.events;
create policy "read events" on public.events for select using (auth.role() = 'authenticated');
drop policy if exists "read team_info" on public.team_info;
create policy "read team_info" on public.team_info for select using (auth.role() = 'authenticated');

drop policy if exists "update own player row" on public.players;
create policy "update own player row" on public.players for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists "admin write fines" on public.fines;
create policy "admin write fines" on public.fines for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin insert fine_log" on public.fine_log;
create policy "admin insert fine_log" on public.fine_log for insert
  with check (public.is_admin());
drop policy if exists "admin delete fine_log" on public.fine_log;
create policy "admin delete fine_log" on public.fine_log for delete
  using (public.is_admin());
drop policy if exists "update fine_log" on public.fine_log;
create policy "update fine_log" on public.fine_log for update
  using (public.is_admin() or player_id = auth.uid())
  with check (public.is_admin() or player_id = auth.uid());

drop policy if exists "admin write announcements" on public.announcements;
create policy "admin write announcements" on public.announcements for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin write events" on public.events;
create policy "admin write events" on public.events for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin write team_info" on public.team_info;
create policy "admin write team_info" on public.team_info for update
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- Storage policies for crest / profile photo uploads.
--
-- IMPORTANT — do this part first, in the dashboard, before running
-- the two policies below:
--   Storage (left sidebar) → "New bucket" → name it exactly:  media
--   Toggle "Public bucket" ON → Create bucket
-- ============================================================
drop policy if exists "public read media" on storage.objects;
create policy "public read media" on storage.objects for select
  using (bucket_id = 'media');
drop policy if exists "authenticated upload media" on storage.objects;
create policy "authenticated upload media" on storage.objects for insert
  with check (bucket_id = 'media' and auth.role() = 'authenticated');
drop policy if exists "authenticated update own media" on storage.objects;
create policy "authenticated update own media" on storage.objects for update
  using (bucket_id = 'media' and auth.role() = 'authenticated');
