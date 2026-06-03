-- Sided — database schema (Postgres / Supabase)
-- Run in the Supabase SQL editor. Assumes Supabase Auth provides auth.users.

-- ─────────────────────────────────────────────────────────
-- Profiles (1:1 with auth.users). Created on first sign-in.
-- ─────────────────────────────────────────────────────────
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  username        text unique not null,
  avatar          int  not null default 0,
  fav_team        text,
  is_pro          boolean not null default false,
  stripe_customer_id text,
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────
-- Reference data synced from the providers
-- ─────────────────────────────────────────────────────────
create table competitions (
  code  text primary key,          -- 'PL', 'PD', 'WC', ...
  name  text not null,
  provider text not null default 'football-data'
);

create table fixtures (
  id          bigint primary key,   -- provider match id (idempotent upserts)
  competition text not null,    -- 'PL'/'WC' (football-data) or 'Saudi Pro League' (API-Football)
  home_team   text not null,
  away_team   text not null,
  utc_date    timestamptz not null,
  status      text not null,        -- SCHEDULED | TIMED | IN_PLAY | FINISHED ...
  home_score  int,
  away_score  int,
  matchday    int,
  updated_at  timestamptz not null default now()
);
create index on fixtures (competition, utc_date);
create index on fixtures (status);

-- ─────────────────────────────────────────────────────────
-- Predictions (1 per user per fixture)
-- ─────────────────────────────────────────────────────────
create table predictions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  fixture_id  bigint not null references fixtures(id) on delete cascade,
  pick        char(1) not null check (pick in ('H','D','A')),
  pred_home   int,
  pred_away   int,
  points      int,                  -- null until settled
  settled     boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, fixture_id)
);
create index on predictions (fixture_id) where settled = false;

-- ─────────────────────────────────────────────────────────
-- Social: follows, team follows, diary, comments
-- ─────────────────────────────────────────────────────────
create table follows (
  follower_id uuid references profiles(id) on delete cascade,
  followee_id uuid references profiles(id) on delete cascade,
  primary key (follower_id, followee_id)
);

create table team_follows (
  user_id uuid references profiles(id) on delete cascade,
  team    text not null,
  primary key (user_id, team)
);

create table diary_posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  home        text not null,
  away        text not null,
  home_score  int not null,
  away_score  int not null,
  league      text not null,
  rating      int not null check (rating between 1 and 5),
  note        text,
  visibility  text not null default 'public' check (visibility in ('private','friends','public')),
  created_at  timestamptz not null default now()
);

create table comments (
  id        uuid primary key default gen_random_uuid(),
  post_id   uuid not null references diary_posts(id) on delete cascade,
  user_id   uuid not null references profiles(id) on delete cascade,
  body      text not null,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────
-- Private leagues (points or self-settled money pools)
-- The app NEVER holds money: cash_stake is only a tracked number.
-- ─────────────────────────────────────────────────────────
create table leagues (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  name        text not null,
  code        text unique not null,     -- shareable invite code
  competition text not null,
  scope       text not null check (scope in ('gameweek','season')),
  split       text not null default 'top3',
  entry       int  not null default 100, -- points entry
  cash_stake  numeric,                   -- null = points only; number = €/player (tracked, not held)
  created_at  timestamptz not null default now()
);

create table league_members (
  league_id uuid references leagues(id) on delete cascade,
  user_id   uuid references profiles(id) on delete cascade,
  points    int not null default 0,
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);

-- ─────────────────────────────────────────────────────────
-- Row-level security (enable + minimal policies)
-- ─────────────────────────────────────────────────────────
alter table profiles      enable row level security;
alter table predictions   enable row level security;
alter table diary_posts   enable row level security;
alter table comments      enable row level security;
alter table follows       enable row level security;
alter table team_follows  enable row level security;
alter table leagues       enable row level security;
alter table league_members enable row level security;

-- profiles: anyone can read, only owner can update
create policy "profiles_read"   on profiles for select using (true);
create policy "profiles_update" on profiles for update using (auth.uid() = id);

-- predictions: owner only (the API also enforces fixture-not-started)
create policy "pred_owner" on predictions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- diary: read if public, or friends-of, or own; write own
create policy "diary_read" on diary_posts for select using (
  visibility = 'public'
  or user_id = auth.uid()
  or (visibility = 'friends' and exists (
        select 1 from follows f where f.follower_id = auth.uid() and f.followee_id = diary_posts.user_id))
);
create policy "diary_write" on diary_posts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- fixtures + competitions are written only by the service role (sync job); readable by all
alter table fixtures     enable row level security;
alter table competitions enable row level security;
create policy "fixtures_read"     on fixtures     for select using (true);
create policy "competitions_read" on competitions for select using (true);

-- profiles: allow a user to insert their own row (used by POST /api/profile via client too)
create policy "profiles_insert" on profiles for insert with check (auth.uid() = id);

-- ─────────────────────────────────────────────────────────
-- Leaderboard view (points + accuracy per user)
-- ─────────────────────────────────────────────────────────
create view leaderboard as
select p.id, p.username, p.avatar,
  count(pr.*) filter (where pr.settled)                       as settled,
  coalesce(sum(pr.points), 0)                                  as points,
  case when count(pr.*) filter (where pr.settled) > 0
       then round(100.0 * count(pr.*) filter (where pr.settled and pr.points > 0)
                        / count(pr.*) filter (where pr.settled))
       else null end                                           as accuracy
from profiles p
left join predictions pr on pr.user_id = p.id
group by p.id;

-- ─────────────────────────────────────────────────────────
-- Moderation: blocks + reports
-- ─────────────────────────────────────────────────────────
create table blocks (
  blocker_id uuid references profiles(id) on delete cascade,
  blocked_id uuid references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
create table reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid references profiles(id) on delete cascade,
  target_type  text not null check (target_type in ('post','comment','user')),
  target_id    text not null,
  reason       text,
  created_at   timestamptz not null default now()
);
alter table blocks  enable row level security;
alter table reports enable row level security;
create policy "blocks_owner"  on blocks  for all using (auth.uid() = blocker_id) with check (auth.uid() = blocker_id);
create policy "reports_insert" on reports for insert with check (auth.uid() = reporter_id);
