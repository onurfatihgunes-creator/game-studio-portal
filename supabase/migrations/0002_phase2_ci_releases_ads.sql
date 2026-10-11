-- Phase 02: CI runs, release candidates, advertising config, AdMob revenue.
-- Additive only; run after 0001_init.sql. Safe to run more than once.

-- ── project facts read from ProjectSettings/ProjectSettings.asset during scans ──
alter table public.games add column if not exists project_facts jsonb not null default '{}'::jsonb;

-- ── shared-CI detection on workflows ────────────────────────────────
alter table public.game_workflows
  add column if not exists ci_ref text,                                  -- owner/unity-ci/.github/workflows/x.yml@ref
  add column if not exists ci_actions text[] not null default '{}';      -- options of workflow_dispatch input "action"

-- ── build_runs: real GitHub Actions runs of a game's CI workflow ────
create table if not exists public.build_runs (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references public.games (id) on delete cascade,
  github_run_id    bigint not null,
  workflow_path    text not null,
  action           text,                 -- smoke | test-editmode | test-playmode | android-dev | android-release | ios-validate | null (unknown)
  title            text,
  head_sha         text,
  head_branch      text,
  event            text,
  status           text,
  conclusion       text,
  run_number       integer,
  run_attempt      integer,
  html_url         text,
  started_at       timestamptz,
  completed_at     timestamptz,
  duration_s       integer,
  failed_job       text,
  failed_step      text,
  version          text,
  build_number     integer,
  bundle_id        text,
  unity_version    text,
  summary          jsonb,                -- validated portal-result.json (tests, error_summary, artifact hashes)
  artifacts        jsonb not null default '[]'::jsonb,   -- [{id,name,size_bytes,expired,expires_at}]
  synced_at        timestamptz not null default now(),
  unique (game_id, github_run_id)
);
create index if not exists build_runs_game_idx on public.build_runs (game_id, started_at desc);

-- ── game_releases: release candidates with MANUAL approval (no store publishing) ──
create table if not exists public.game_releases (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  game_id           uuid not null references public.games (id) on delete cascade,
  platform          text not null check (platform in ('android', 'ios')),
  version           text not null,
  build_number      integer not null,
  build_run_id      uuid references public.build_runs (id) on delete set null,
  artifact_id       bigint,
  artifact_name     text,
  head_sha          text,
  readiness         jsonb not null,       -- snapshot of the checks when the candidate was created
  status            text not null default 'candidate'
                      check (status in ('candidate', 'approved', 'rejected', 'published_manually')),
  decided_by        uuid,
  decided_by_email  text,
  decided_at        timestamptz,
  notes             text,
  unique (game_id, platform, version, build_number)
);

-- ── advertising config (one row per game); Unity reads an exported JSON ──
create table if not exists public.game_ads_config (
  game_id           uuid primary key references public.games (id) on delete cascade,
  updated_at        timestamptz not null default now(),
  updated_by_email  text,
  enabled           boolean not null default false,
  test_mode         boolean not null default true,
  android           jsonb not null default '{}'::jsonb,   -- {app_id, rewarded, interstitial, banner}
  ios               jsonb not null default '{}'::jsonb,
  banner_enabled    boolean not null default false,
  banner_position   text not null default 'bottom' check (banner_position in ('top', 'bottom')),
  caps              jsonb not null default '{}'::jsonb,   -- frequency caps
  consent           jsonb not null default '{}'::jsonb,   -- {tag_child_directed, tag_under_age_of_consent, max_ad_content_rating}
  notes             text
);

-- ── AdMob reporting: one connection, daily metrics per game ─────────
create table if not exists public.admob_connection (
  id                int primary key default 1 check (id = 1),
  publisher_id      text,
  token_ciphertext  text not null,        -- AES-256-GCM, key only in server env (ADMOB_TOKEN_ENCRYPTION_KEY)
  scope             text,
  connected_by_email text,
  connected_at      timestamptz not null default now(),
  last_synced_at    timestamptz,
  last_error        text
);
create table if not exists public.revenue_daily (
  game_id           uuid not null references public.games (id) on delete cascade,
  day               date not null,
  currency          text not null,
  earnings_micros   bigint not null,
  impressions       bigint not null,
  clicks            bigint not null default 0,
  synced_at         timestamptz not null default now(),
  primary key (game_id, day)
);

-- ── RLS: same single-tenant model as 0001 (every signed-in member), no anon access ──
alter table public.build_runs       enable row level security;
alter table public.game_releases    enable row level security;
alter table public.game_ads_config  enable row level security;
alter table public.admob_connection enable row level security;
alter table public.revenue_daily    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['build_runs', 'game_releases', 'game_ads_config', 'admob_connection', 'revenue_daily'] loop
    execute format('drop policy if exists "members read %1$s" on public.%1$I', t);
    execute format('drop policy if exists "members insert %1$s" on public.%1$I', t);
    execute format('drop policy if exists "members update %1$s" on public.%1$I', t);
    execute format('drop policy if exists "members delete %1$s" on public.%1$I', t);
    execute format('create policy "members read %1$s"   on public.%1$I for select to authenticated using (true)', t);
    execute format('create policy "members insert %1$s" on public.%1$I for insert to authenticated with check (true)', t);
    execute format('create policy "members update %1$s" on public.%1$I for update to authenticated using (true) with check (true)', t);
    execute format('create policy "members delete %1$s" on public.%1$I for delete to authenticated using (true)', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
