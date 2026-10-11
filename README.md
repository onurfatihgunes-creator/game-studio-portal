# Game Studio Portal

One place to manage **advertising across every Unity mobile game**. Three sections:

- **Games** — connect Unity repositories from GitHub (one by one, or many at once).
- **Advertising** — set one shared advertising policy and press **Apply to All Games**.
- **Revenue** — read-only AdMob revenue per game.

Next.js 16 (App Router) · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Storage) · GitHub App · Vercel-compatible. No queues, workers or extra services.

## Apply to All Games

Advertising → **Apply to All Games** does, for every connected Unity game and safely repeatably:

1. Saves and publishes the shared policy (see below) and checks the public file by fetching it back.
2. Reads each game's repository on GitHub and finds out whether the shared module `com.studio.ads` is installed (and which version), whether a pull request already exists, and whether the game has declared and verified placement hooks.
3. Opens **one reviewable pull request** only where the repository must change — or updates the existing one in place. It never merges, never touches the default branch, never edits gameplay.
4. Shows a result per game: **Applied · Pull request awaiting approval · Needs AdMob IDs · Needs game integration · Failed**.

Rules the engine enforces (and the tests prove):

- Each game gets **only its own AdMob IDs** (from its saved Advertising settings). An ID already used by another game is refused. A game without its own IDs is *Needs AdMob IDs*; nothing is invented and no pull request is made.
- New integrations ship **disabled and in test mode**. Existing files and configs are never overwritten: managed module files are replaced only when the module is older; in an existing config only *missing* keys are added.
- Re-running creates **no duplicate pull request or commit**. A pull request made by the earlier onboarding tool (branch `studio-ci-onboarding`) is recognised and updated instead of duplicated. A closed integration branch is not recreated.
- *Applied* means the integration is on the game's default branch and the remote policy is configured. It does **not** mean a build containing it has reached players — that is not tracked.

### Two kinds of settings
| | Where it lives | How it changes |
|---|---|---|
| **Central policy** — ads on/off, banner on/off + position, interstitial frequency (every N runs, min seconds, max per session, first delay), rewarded availability + cooldown | one public JSON file | Edit on the Advertising page → **Apply**. Integrated games fetch it at runtime: **no rebuild**. |
| **Unity integration** — the shared module and Google plugin, the game's own AdMob IDs, production mode, and the game-specific placement hooks (which screens/events show a banner or interstitial) | each game's repository | Only through a reviewed pull request. |

Policy file: `<SUPABASE_URL>/storage/v1/object/public/ads-policy/policy.json`. Trust model (enforced in the Unity module, `Packages/com.studio.ads`): https only, 16 KB / 8 s limits, schema-checked, last good copy cached for 30 days, any failure falls back to the cache and then to the game's own config. The remote file can switch ads **off**, force **test mode**, change caps/banner/rewarded; it can switch **test** ads on only in a game whose own config is test mode; it can **never switch production ads on** and never carries IDs. Turning an ads-off game on, or changing test mode, takes effect at the next app launch.

Placement hooks are game-specific: a game declares them in `Assets/StudioAds/StudioAdsPlacements.json` (`hooks` = the C# file that calls the module). The portal verifies that file exists; it cannot verify behaviour.

### One-time owner steps
1. Run `supabase/migrations/0003_ads_apply_all.sql` in the Supabase SQL Editor (creates `ads_policy`, `ads_apply_result` and the public `ads-policy` bucket).
2. GitHub App → Permissions → **Contents** and **Pull requests**: *Read & write* → accept on the installation.
3. `.env.local`: `ADS_MODULE_REPO` (owner/repo of the private repository holding the module) and `ADS_MODULE_REF` (a tag such as `ads-v0.4.0`).

## What is real, and what is "Not configured"

| Field | Source | If it can't be found |
|---|---|---|
| Repository, default branch, latest commit | GitHub REST API | game cannot be added |
| Unity version / project path | `ProjectSettings/ProjectVersion.txt` (repo root, else nested search) | "Not detected" |
| Ads SDK / module | `Packages/manifest.json`, `Packages/com.studio.ads/package.json`, `Assets/Resources/StudioAdsConfig.json` — shown as present, never "live" | "Not configured" |
| Type (Mini/Premium), development status | **You set these** | — |
| Revenue | AdMob reports, only after you authorize Google | "Not connected" |

## Security model

- **Portal login:** Supabase Auth (email + password). Every route except `/login` is gated in `src/proxy.ts`, and every page/server action re-checks the session (`requireUser`).
- **No service-role key anywhere.** The app uses only the public anon key, acting as the signed-in user under Row Level Security (`supabase/migrations/0001_init.sql`). Anonymous users have no table access.
- **GitHub access: a GitHub App**, not a personal token. Permissions: *Metadata: read*, *Contents: read & write* and *Pull requests: read & write* (write only so **Apply to All Games** can create a branch and open a pull request; it never merges and never touches the default branch). Installation tokens are minted server-side from the App's private key (1 h, in-memory cache). Nothing GitHub-related reaches the browser.
- **Remote policy file:** a public JSON in a Supabase Storage bucket (`ads-policy`). Public *read* by URL only (no key in any game); only signed-in portal members can *write*. It contains frequency caps and on/off flags, never AdMob IDs or secrets.
- **Removing a game** requires typing its name and only deletes the portal record — never the repo.

> RLS grants all signed-in users full access (single-tenant studio). **Turn off public sign-ups** in Supabase (step 3 below), otherwise anyone could register.

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Run `supabase/migrations/0001_init.sql`, then `0002_phase2_ci_releases_ads.sql`, then `0003_ads_apply_all.sql` — paste each into the SQL editor (all are additive and safe to repeat), or `supabase link && supabase db push`.
3. **Authentication → Sign In / Providers →** turn **off** "Allow new users to sign up". Then **Authentication → Users → Add user** (tick *Auto Confirm*) for yourself and teammates.
4. **Project Settings → API:** copy the project URL and the **anon** key.

### 2. Create the GitHub App

GitHub → Settings (or the org's settings) → Developer settings → GitHub Apps → **New GitHub App**:

- Name: anything (e.g. `my-studio-portal`); Homepage URL: your portal URL (any URL works).
- **Webhook: uncheck "Active".** Leave "Request user authorization (OAuth)" unchecked — the portal doesn't use user-to-server tokens.
- Repository permissions: **Metadata: Read-only**, **Contents: Read and write**, **Pull requests: Read and write**. Nothing else. *(With Contents read-only the portal still works and reports every game, but "Apply to All Games" cannot open pull requests.)*
- "Where can this app be installed?": **Only on this account**.
- Create it, then: note the **App ID**, note the slug from the URL (`github.com/apps/<slug>`), and **Generate a private key** (downloads a `.pem`).
- **Install App** → choose your account/org → **Only select repositories** → pick your game repos (you can add more later; the wizard links there).

### 3. Run locally

Requires Node 22.9+ (the connection-test script uses `--env-file-if-exists`).

```bash
npm install
cp .env.example .env.local     # fill in the values
npm run dev                    # http://localhost:3000
```

`GITHUB_APP_PRIVATE_KEY` accepts the PEM with literal `\n`, or the whole file base64-encoded (`base64 -i key.pem | tr -d '\n'`) — the latter is easiest on Vercel.

### 4. Real connection test

Talks to the real GitHub and Supabase APIs with your `.env.local`; writes nothing:

```bash
npm run test:connection                       # App credentials, installations, repo listing, DB + RLS check
npm run test:connection -- your-org/your-game # also runs the full scan on one repo and prints what it found
```

Optionally set `PORTAL_TEST_EMAIL` / `PORTAL_TEST_PASSWORD` (a Supabase user) in `.env.local` to also verify signed-in reads. Exit code is non-zero on any failed check. When signed in, `GET /api/health` runs the same credential checks.

Unit/integration tests (no network): `npm test` — App-JWT signing, the scan pipeline against an in-memory GitHub fake, bulk import, ad-config validation, and the whole Apply-to-all engine against an in-memory repository (new integration, reuse of an existing pull request, repeat runs, ID isolation, permissions, remote policy publishing). `npm run typecheck` for types.

### 5. Deploy to Vercel

1. Push this folder to a Git repo and import it in Vercel (framework: Next.js, Node 22).
2. Add the env vars from `.env.example` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `ADS_MODULE_REPO`, `ADS_MODULE_REF`; optionally `MASTER_PM_BASE_URL`). Mark the private key as **Sensitive**.
3. Deploy, sign in, and run the connection test locally against the same credentials.

No GitHub webhook or callback URL is needed, so there's nothing to update after the first deploy.

## Bulk import

`/games/import` lists every repository the GitHub App can see, minus those already connected, and checks each (read-only, one API call per repo) for a `ProjectSettings` folder at the repository root. Only confirmed Unity repositories are listed by default, and nothing is preselected or imported until you choose. Detection shows a progress bar and the final count appears only when every repository has been checked. You can edit each game's name, type and status, or set type/status for all selected rows at once, then **Import**. Imports run 4 at a time; each row ends as *Added*, *Already connected*, *Not imported* (permanent: no Unity project, repository not found or inaccessible; not retryable) or *Failed* (possibly temporary, e.g. GitHub 5xx, rate limit, network; shown with the message and retryable). Each import does the same fresh server-side scan as the single-game wizard, and bulk import refuses any repository where that scan finds no Unity project (so reusable engine/tool repos can't be added by accident; use **Connect one game** if you really want one), and duplicates are impossible: `games.github_repo_id` is unique.

Unity projects inside subfolders aren't found by the quick check; tick **Show all repositories**, select them manually, and the import scan will locate the nested project.

The browser calls small route handlers (`/api/games/discover|import|refresh`) rather than Server Actions because Next dispatches Server Actions one at a time per client. The handlers require a same-origin JSON request and a valid Supabase session.

## AdMob revenue (read-only)
Set `GOOGLE_OAUTH_CLIENT_ID/SECRET` and `ADMOB_TOKEN_ENCRYPTION_KEY` (see `.env.example`), register the redirect URI, then **Revenue → Connect AdMob** (scopes `admob.readonly` + `admob.report`, PKCE). Only the refresh token is stored, AES-256-GCM encrypted with a key that exists only in server env. **Sync now** pulls the last 30 days of network reports; revenue is attributed to a game only when its production AdMob app ID is set. Until connected the page says “Not connected”; eCPM is computed only when there are impressions.


### AdMob OAuth: the Google Cloud steps that cannot be automated
1. Google Cloud Console → create or pick a project → *APIs & Services ▸ Library* → enable **AdMob API**.
2. *Google Auth platform* (OAuth consent screen): user type **External**, fill the app name/email, add the AdMob owner as a test user, then set **Publishing status = In production**. In *Testing* status Google expires the refresh token after **7 days** (Google OAuth docs), and you would have to reconnect weekly. (An unverified-app warning screen appears for one-person use; accept it.)
3. *Credentials ▸ Create credentials ▸ OAuth client ID ▸ Web application*; add the authorized redirect URI `http://localhost:3000/api/integrations/admob/callback` (plus `https://YOUR-DOMAIN/api/integrations/admob/callback` once deployed). Download the JSON.
4. Put the client ID/secret into `.env.local` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (`ADMOB_TOKEN_ENCRYPTION_KEY` is already generated), restart the dev server, then **Revenue ▸ Connect AdMob** with the Google account that owns the AdMob account.

## Master Game PM boundary

`src/lib/integrations/master-pm.ts` is the only place the portal may talk about Master Game PM. Today it only builds a deep link from `MASTER_PM_BASE_URL` + a per-game `pm_ref` (editable on the game page). It never reads, writes or deletes anything in the PM project.

## Layout

```
supabase/migrations/   schema + RLS (0003 = Apply to All Games)
src/proxy.ts           session refresh + route protection
src/lib/ads/           policy, apply engine, module bundle, config validation
src/lib/github/        app auth, scanner, repository git operations (server-only)
src/app/(portal)/      Games, Advertising, Revenue
scripts/connection-test.ts
tests/
```

## Known limitations

- **AdMob connection status: BLOCKED on Google's side (diagnosed 2026-10-11).** OAuth completes, but `GET /v1/accounts` answers **HTTP 401 UNAUTHENTICATED** from the AdMob backend with a valid token and both scopes; the request matches Google's official client. Revenue stays empty until that is resolved on the AdMob account holder's side. Applying advertising does not depend on it.
- **Placement hooks are per game.** The portal can install the module and the policy, not decide where in a game's code an ad belongs.
- **Real ad display is untested** (needs a device). iOS also needs the ATT prompt and usage string.
- **AdMob apps and ad units are created in AdMob.** The API's create methods exist only in v1beta and make irreversible production changes; the portal does not use them.
- **The remote policy file is public** (read-only for the world). Anyone who controls its URL could disable ads or force demo ads in games that use it, and a device fetching it exposes its IP to the host.
- **Single-tenant, one role.** All signed-in users can do everything; auth is email + password only. The games list isn't paginated (fine for ~150). GitHub rate limits apply: an Apply run is roughly 10 API calls per game.
- Snapshots, no webhooks: scan data is as fresh as the last Refresh; Apply reads each repository live.
