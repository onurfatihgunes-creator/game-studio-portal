-- Game Studio Portal — "Apply advertising to all games"
-- Additive and idempotent (safe to run more than once). Creates two small tables and one public storage bucket.
-- Nothing is dropped, altered or deleted. Run in the Supabase SQL Editor.

-- ── the ONE shared advertising policy (single row) ──────────────────
create table if not exists public.ads_policy (
  id                int primary key default 1 check (id = 1),
  updated_at        timestamptz not null default now(),
  updated_by_email  text,
  version           int not null default 0,                -- the published policyVersion (incremented only when the policy changes)
  published_at      timestamptz,
  policy            jsonb not null default '{}'::jsonb
);

-- ── last result of "Apply to All Games", one row per game ───────────
create table if not exists public.ads_apply_result (
  game_id           uuid primary key references public.games (id) on delete cascade,
  updated_at        timestamptz not null default now(),
  status            text not null check (status in ('applied', 'pr_open', 'needs_ids', 'needs_integration', 'failed')),
  detail            text,
  action            text,                                   -- created_pr | updated_pr | none | blocked
  module_version    text,                                   -- version found in the default branch (null = not installed)
  hooks             boolean,                                -- game-specific placement hooks verified in the default branch
  pr_number         int,
  pr_url            text,
  branch            text
);

alter table public.ads_policy       enable row level security;
alter table public.ads_apply_result enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ads_policy', 'ads_apply_result'] loop
    execute format('drop policy if exists "members read %1$s" on public.%1$I', t);
    execute format('drop policy if exists "members insert %1$s" on public.%1$I', t);
    execute format('drop policy if exists "members update %1$s" on public.%1$I', t);
    execute format('drop policy if exists "members delete %1$s" on public.%1$I', t);
    execute format('create policy "members read %1$s"   on public.%1$I for select to authenticated using (true)', t);
    execute format('create policy "members insert %1$s" on public.%1$I for insert to authenticated with check (true)', t);
    execute format('create policy "members update %1$s" on public.%1$I for update to authenticated using (true) with check (true)', t);
    execute format('create policy "members delete %1$s" on public.%1$I for delete to authenticated using (true)', t);
  end loop;
end $$;
revoke all on public.ads_policy, public.ads_apply_result from anon;

-- ── public bucket for the policy file games fetch at runtime ────────
-- Public READ by URL (no key, no credential in any game). Only signed-in portal members can WRITE.
-- The file holds frequency caps and on/off flags only: no AdMob IDs, no secrets.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ads-policy', 'ads-policy', true, 20000, array['application/json'])
on conflict (id) do update set public = true, file_size_limit = 20000, allowed_mime_types = array['application/json'];

drop policy if exists "ads-policy members read"   on storage.objects;
drop policy if exists "ads-policy members insert" on storage.objects;
drop policy if exists "ads-policy members update" on storage.objects;
create policy "ads-policy members read"   on storage.objects for select to authenticated using (bucket_id = 'ads-policy');
create policy "ads-policy members insert" on storage.objects for insert to authenticated with check (bucket_id = 'ads-policy');
create policy "ads-policy members update" on storage.objects for update to authenticated using (bucket_id = 'ads-policy') with check (bucket_id = 'ads-policy');
