-- Game Studio Portal — initial schema
-- Single-tenant: every signed-in user is a studio member. Disable public sign-ups
-- in Supabase (Authentication → Sign In / Providers → "Allow new users to sign up" off).

create extension if not exists pgcrypto;

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── games ───────────────────────────────────────────────────────────
-- One row per connected repository. A row exists ONLY after the GitHub API has
-- successfully returned the repository (connected_at is set from that response).
create table public.games (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- user-set fields (cannot be detected from GitHub)
  name                  text not null check (char_length(name) between 1 and 120),
  game_type             text not null check (game_type in ('mini', 'premium')),
  dev_status            text not null default 'in_development'
                          check (dev_status in ('prototype', 'in_development', 'soft_launch', 'live', 'paused')),

  -- repository (from GitHub)
  github_installation_id bigint not null,
  github_repo_id        bigint not null unique,
  owner                 text not null,
  repo                  text not null,
  full_name             text not null,
  html_url              text not null,
  description           text,
  default_branch        text not null,
  is_private            boolean not null,
  is_archived           boolean not null default false,
  repo_pushed_at        timestamptz,

  -- unity detection
  unity_detected        boolean not null default false,
  unity_version         text,
  unity_project_path    text,            -- '' = repo root
  unity_note            text,            -- e.g. "nested project search skipped"

  -- documentation detected: [{ "path": "README.md", "kind": "readme" }, ...]
  docs                  jsonb not null default '[]'::jsonb,

  -- monetization SDKs found in Packages/manifest.json:
  -- { "admob": bool, "iap": bool, "other_ads": ["ironSource", ...], "checked": bool }
  monetization          jsonb not null default '{"checked": false}'::jsonb,

  -- latest commit on the default branch
  commit_sha            text,
  commit_message        text,
  commit_author         text,
  commit_at             timestamptz,
  commit_url            text,

  -- sync bookkeeping
  connected_at          timestamptz not null,
  last_synced_at        timestamptz not null,
  last_sync_error       text,

  -- Integration boundary for the existing Master Game PM (opaque reference, never dereferenced here)
  pm_ref                text
);
create index games_name_idx on public.games (lower(name));
create trigger games_updated_at before update on public.games
  for each row execute function public.set_updated_at();

-- ── game_workflows ──────────────────────────────────────────────────
-- Workflows found in .github/workflows. "kinds" is heuristic, derived from file
-- contents; "signals" records why, so the UI can show its evidence.
create table public.game_workflows (
  id                    uuid primary key default gen_random_uuid(),
  game_id               uuid not null references public.games (id) on delete cascade,
  github_workflow_id    bigint,          -- null if GitHub has not registered the file
  name                  text not null,
  path                  text not null,
  state                 text,            -- active | disabled_manually | ...
  kinds                 text[] not null default '{}',   -- subset of test|build|publish
  platforms             text[] not null default '{}',   -- subset of android|ios
  signals               text[] not null default '{}',
  triggers              text[] not null default '{}',
  dispatchable          boolean not null default false, -- has workflow_dispatch AND is active
  has_required_inputs   boolean not null default false,

  -- latest run on the default branch (null columns = no run found)
  run_id                bigint,
  run_number            integer,
  run_status            text,            -- queued | in_progress | completed | ...
  run_conclusion        text,            -- success | failure | cancelled | ...
  run_event             text,
  run_branch            text,
  run_url               text,
  run_started_at        timestamptz,
  run_updated_at        timestamptz,

  updated_at            timestamptz not null default now(),
  unique (game_id, path)
);
create index game_workflows_game_idx on public.game_workflows (game_id);
create trigger game_workflows_updated_at before update on public.game_workflows
  for each row execute function public.set_updated_at();

-- ── workflow_dispatches (audit log of manual triggers) ──────────────
create table public.workflow_dispatches (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  game_id               uuid references public.games (id) on delete set null,
  game_name             text not null,
  workflow_path         text not null,
  workflow_kinds        text[] not null default '{}',
  ref                   text not null,
  user_id               uuid not null default auth.uid(),
  user_email            text,
  outcome               text not null check (outcome in ('accepted', 'rejected')),
  detail                text
);
create index workflow_dispatches_created_idx on public.workflow_dispatches (created_at desc);

-- ── Row level security ──────────────────────────────────────────────
alter table public.games               enable row level security;
alter table public.game_workflows      enable row level security;
alter table public.workflow_dispatches enable row level security;

create policy "members read games"   on public.games for select to authenticated using (true);
create policy "members insert games" on public.games for insert to authenticated with check (true);
create policy "members update games" on public.games for update to authenticated using (true) with check (true);
create policy "members delete games" on public.games for delete to authenticated using (true);

create policy "members read workflows"   on public.game_workflows for select to authenticated using (true);
create policy "members insert workflows" on public.game_workflows for insert to authenticated with check (true);
create policy "members update workflows" on public.game_workflows for update to authenticated using (true) with check (true);
create policy "members delete workflows" on public.game_workflows for delete to authenticated using (true);

-- Audit log is append-only for members.
create policy "members read dispatches"   on public.workflow_dispatches for select to authenticated using (true);
create policy "members insert dispatches" on public.workflow_dispatches for insert to authenticated
  with check (user_id = auth.uid());

-- No access for anonymous users: no policies for the anon role.
revoke all on public.games, public.game_workflows, public.workflow_dispatches from anon;
