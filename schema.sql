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
  is_committee boolean not null default false,
  season_paid numeric not null default 0,
  created_at timestamptz not null default now()
);
-- safe to re-run on an existing table:
alter table public.players add column if not exists is_committee boolean not null default false;
alter table public.players add column if not exists onboarded boolean not null default false;
-- One-time backfill: anyone who's already set up a profile photo has clearly
-- already been using the app, so don't force them through the new first-login
-- screen retroactively — only genuinely new signups should see it.
update public.players set onboarded = true where onboarded = false and photo_url is not null;

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
  waived boolean not null default false,
  created_at timestamptz not null default now()
);
-- safe to re-run on an existing table:
alter table public.fine_log add column if not exists waived boolean not null default false;

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
  paypal_link text,
  monzo_link text,
  bank_account_name text,
  bank_sort_code text,
  bank_account_number text,
  bank_reference text,
  double_bubble boolean not null default false,
  constraint single_row check (id = 1)
);
insert into public.team_info (id, name) values (1, 'My Team')
  on conflict (id) do nothing;

-- 7. Event suggestions — any player can drop in an idea for a social
create table if not exists public.event_suggestions (
  id uuid primary key default gen_random_uuid(),
  suggested_by uuid references public.players(id) on delete set null,
  text text not null,
  created_at timestamptz not null default now()
);

-- 8. Event polls — an admin asks a question with a few options, everyone
--    gets one vote each, and the tally updates live as votes come in.
create table if not exists public.event_polls (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  options jsonb not null, -- e.g. ["Nando's","Prezzo","Wagamama"]
  closed boolean not null default false,
  created_by uuid references public.players(id),
  created_at timestamptz not null default now()
);
create table if not exists public.event_poll_votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.event_polls(id) on delete cascade,
  voter_id uuid not null references public.players(id) on delete cascade,
  option_index int not null,
  created_at timestamptz not null default now(),
  unique(poll_id, voter_id)
);

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
  -- auth.uid() is only set when the edit comes through the app's API as a
  -- signed-in user. Dashboard/SQL Editor edits (e.g. bootstrapping the first
  -- admin) have no auth.uid() and are trusted, so they pass through untouched.
  if auth.uid() is not null and not public.is_admin() then
    new.is_admin := old.is_admin;         -- can't self-promote to admin
    new.is_committee := old.is_committee; -- or onto the Committee
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
  if auth.uid() is not null and not public.is_admin() then
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

-- Lets an admin "manually add" a player by email: they type a name + email,
-- the app writes it here, then triggers a sign-in email for that address.
-- The moment that email creates an auth.users row (even before they click
-- the link!), handle_new_user below picks up the pre-set name.
create table if not exists public.pending_invites (
  email text primary key,
  name text not null,
  invited_by uuid references public.players(id),
  created_at timestamptz not null default now()
);
alter table public.pending_invites enable row level security;
drop policy if exists "admin manage pending_invites" on public.pending_invites;
create policy "admin manage pending_invites" on public.pending_invites for all
  using (public.is_admin()) with check (public.is_admin());

-- Auto-create a players row the moment someone signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  pending_name text;
begin
  select name into pending_name from public.pending_invites where email = new.email;
  insert into public.players (id, name)
  values (new.id, coalesce(pending_name, new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  delete from public.pending_invites where email = new.email;
  return new;
end;
$$;
drop trigger if exists trg_new_user on auth.users;
create trigger trg_new_user after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- COURT — dispute a fine in front of the Committee, chat about it,
-- get voted guilty / not guilty. Not-guilty automatically waives the
-- disputed fine. Fully automatic — no admin has to referee it by hand.
-- ============================================================
create table if not exists public.court_cases (
  id uuid primary key default gen_random_uuid(),
  defendant_id uuid not null references public.players(id) on delete cascade,
  fine_log_id uuid references public.fine_log(id) on delete set null,
  fine_label text,
  reason text not null,
  status text not null default 'open' check (status in ('open','guilty','not_guilty')),
  verdict_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.court_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.court_cases(id) on delete cascade,
  sender_id uuid not null references public.players(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.court_votes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.court_cases(id) on delete cascade,
  voter_id uuid not null references public.players(id) on delete cascade,
  verdict text not null check (verdict in ('guilty','not_guilty')),
  created_at timestamptz not null default now(),
  unique(case_id, voter_id)
);

-- Admins count as Committee too, so you don't have to flag yourself twice.
create or replace function public.is_committee_member()
returns boolean
language sql
security definer
stable
as $$
  select coalesce((select is_admin or is_committee from public.players where id = auth.uid()), false);
$$;

-- Runs every time a vote is cast/changed. Once every eligible Committee
-- member (everyone with is_admin or is_committee, EXCLUDING the defendant
-- themselves, so a committee member on trial can't vote on their own case)
-- has voted, the case auto-resolves by majority, ties go to not guilty, and
-- a not-guilty verdict automatically waives the disputed fine.
create or replace function public.resolve_court_case()
returns trigger
language plpgsql
security definer
as $$
declare
  case_row public.court_cases%rowtype;
  total_committee int;
  total_votes int;
  guilty_votes int;
  notguilty_votes int;
  final_verdict text;
begin
  select * into case_row from public.court_cases where id = new.case_id;
  if case_row.status <> 'open' then
    return new; -- already decided, nothing left to do
  end if;

  select count(*) into total_committee
    from public.players
    where (is_admin or is_committee) and id <> case_row.defendant_id;

  select count(*) into total_votes from public.court_votes where case_id = new.case_id;

  if total_committee = 0 or total_votes < total_committee then
    return new; -- still waiting on someone
  end if;

  select count(*) filter (where verdict = 'guilty'), count(*) filter (where verdict = 'not_guilty')
    into guilty_votes, notguilty_votes
    from public.court_votes where case_id = new.case_id;

  final_verdict := case when guilty_votes > notguilty_votes then 'guilty' else 'not_guilty' end;

  update public.court_cases
    set status = final_verdict,
        resolved_at = now(),
        verdict_note = format('%s guilty vote(s), %s not guilty vote(s)', guilty_votes, notguilty_votes)
    where id = new.case_id;

  if final_verdict = 'not_guilty' and case_row.fine_log_id is not null then
    update public.fine_log set waived = true, paid = true where id = case_row.fine_log_id;
  end if;

  return new;
end;
$$;
drop trigger if exists trg_resolve_court_case on public.court_votes;
create trigger trg_resolve_court_case after insert or update on public.court_votes
  for each row execute function public.resolve_court_case();

alter table public.court_cases enable row level security;
alter table public.court_messages enable row level security;
alter table public.court_votes enable row level security;

drop policy if exists "read own or committee cases" on public.court_cases;
create policy "read own or committee cases" on public.court_cases for select
  using (defendant_id = auth.uid() or public.is_committee_member());
drop policy if exists "player opens own case" on public.court_cases;
create policy "player opens own case" on public.court_cases for insert
  with check (defendant_id = auth.uid());
-- No update policy on purpose: the ONLY way a case's status/verdict changes
-- is the security-definer trigger above — nobody can resolve their own trial.
drop policy if exists "admin delete court cases" on public.court_cases;
create policy "admin delete court cases" on public.court_cases for delete
  using (public.is_admin());
-- Deleting a case cascades to its messages and votes (see the "on delete
-- cascade" foreign keys above) — this lets an admin wipe test Court data
-- from Team Settings without touching real fines/players/events.

drop policy if exists "read case messages" on public.court_messages;
create policy "read case messages" on public.court_messages for select
  using (exists (
    select 1 from public.court_cases c
    where c.id = case_id and (c.defendant_id = auth.uid() or public.is_committee_member())
  ));
drop policy if exists "post case messages" on public.court_messages;
create policy "post case messages" on public.court_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.court_cases c
      where c.id = case_id and c.status = 'open'
        and (c.defendant_id = auth.uid() or public.is_committee_member())
    )
  );

drop policy if exists "read votes" on public.court_votes;
create policy "read votes" on public.court_votes for select
  using (exists (
    select 1 from public.court_cases c
    where c.id = case_id and (c.defendant_id = auth.uid() or public.is_committee_member())
  ));
drop policy if exists "committee casts vote" on public.court_votes;
create policy "committee casts vote" on public.court_votes for insert
  with check (
    voter_id = auth.uid() and public.is_committee_member()
    and exists (
      select 1 from public.court_cases c
      where c.id = case_id and c.status = 'open' and c.defendant_id <> auth.uid()
    )
  );
drop policy if exists "committee updates own vote" on public.court_votes;
create policy "committee updates own vote" on public.court_votes for update
  using (voter_id = auth.uid() and public.is_committee_member())
  with check (
    voter_id = auth.uid() and public.is_committee_member()
    and exists (
      select 1 from public.court_cases c
      where c.id = case_id and c.status = 'open' and c.defendant_id <> auth.uid()
    )
  );

-- Live chat + live vote tallies while Court is in session. Safe to re-run —
-- these no-op with a friendly error if already added, which we swallow below.
do $$
begin
  alter publication supabase_realtime add table public.court_cases;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.court_messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.court_votes;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- Row Level Security — who can read/write what
-- ============================================================
alter table public.players enable row level security;
alter table public.fines enable row level security;
alter table public.fine_log enable row level security;
alter table public.announcements enable row level security;
alter table public.events enable row level security;
alter table public.team_info enable row level security;
alter table public.event_suggestions enable row level security;
alter table public.event_polls enable row level security;
alter table public.event_poll_votes enable row level security;

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
-- Team name + crest aren't sensitive, and the standalone signup.html page
-- (shared as a plain link, e.g. in WhatsApp) needs to show them to a visitor
-- who isn't signed in yet. Postgres RLS OR-combines multiple permissive
-- policies for the same action, so this simply adds an extra "or anyone" read
-- path on top of the existing authenticated-only one above — it doesn't
-- remove or weaken it.
drop policy if exists "public read team_info" on public.team_info;
create policy "public read team_info" on public.team_info for select using (true);

drop policy if exists "update own player row" on public.players;
create policy "update own player row" on public.players for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
drop policy if exists "admin delete players" on public.players;
create policy "admin delete players" on public.players for delete
  using (public.is_admin());
-- Deleting a player cascades to their own fines, court cases/messages/votes,
-- and poll votes (see the "on delete cascade" foreign keys above/below). Two
-- foreign keys pointed at players didn't specify a delete action, which
-- defaults to blocking the delete entirely if any row still referenced
-- them — patched below so removing a player never gets silently rejected
-- just because they once created a poll or sent an invite.
alter table public.event_polls drop constraint if exists event_polls_created_by_fkey;
alter table public.event_polls add constraint event_polls_created_by_fkey
  foreign key (created_by) references public.players(id) on delete set null;
alter table public.pending_invites drop constraint if exists pending_invites_invited_by_fkey;
alter table public.pending_invites add constraint pending_invites_invited_by_fkey
  foreign key (invited_by) references public.players(id) on delete set null;

drop policy if exists "admin write fines" on public.fines;
create policy "admin write fines" on public.fines for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin insert fine_log" on public.fine_log;
create policy "admin insert fine_log" on public.fine_log for insert
  with check (public.is_admin());
drop policy if exists "admin delete fine_log" on public.fine_log;
create policy "admin delete fine_log" on public.fine_log for delete
  using (public.is_admin());
-- Only admins can mark a fine as paid — players can request/pay outside the
-- app, but cannot confirm their own balance clear, to keep totals trustworthy.
drop policy if exists "update fine_log" on public.fine_log;
create policy "update fine_log" on public.fine_log for update
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admin write announcements" on public.announcements;
create policy "admin write announcements" on public.announcements for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin write events" on public.events;
create policy "admin write events" on public.events for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin write team_info" on public.team_info;
create policy "admin write team_info" on public.team_info for update
  using (public.is_admin()) with check (public.is_admin());

-- Any signed-in player can suggest an event and read the suggestions box;
-- only an admin can clear one out.
drop policy if exists "read event_suggestions" on public.event_suggestions;
create policy "read event_suggestions" on public.event_suggestions for select
  using (auth.role() = 'authenticated');
drop policy if exists "insert own event_suggestion" on public.event_suggestions;
create policy "insert own event_suggestion" on public.event_suggestions for insert
  with check (suggested_by = auth.uid());
drop policy if exists "admin delete event_suggestion" on public.event_suggestions;
create policy "admin delete event_suggestion" on public.event_suggestions for delete
  using (public.is_admin());

-- Only an admin creates/closes a poll; everyone can read and vote once.
drop policy if exists "read event_polls" on public.event_polls;
create policy "read event_polls" on public.event_polls for select
  using (auth.role() = 'authenticated');
drop policy if exists "admin write event_polls" on public.event_polls;
create policy "admin write event_polls" on public.event_polls for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read event_poll_votes" on public.event_poll_votes;
create policy "read event_poll_votes" on public.event_poll_votes for select
  using (auth.role() = 'authenticated');
drop policy if exists "cast own poll vote" on public.event_poll_votes;
create policy "cast own poll vote" on public.event_poll_votes for insert
  with check (
    voter_id = auth.uid()
    and exists (select 1 from public.event_polls p where p.id = poll_id and not p.closed)
  );
drop policy if exists "update own poll vote" on public.event_poll_votes;
create policy "update own poll vote" on public.event_poll_votes for update
  using (voter_id = auth.uid())
  with check (
    voter_id = auth.uid()
    and exists (select 1 from public.event_polls p where p.id = poll_id and not p.closed)
  );

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
