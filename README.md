# Game Studio Portal — MVP 01

A small web portal for tracking a portfolio of Unity mobile games. Connect a game from GitHub in three steps:

1. **Select repository** — pick from the repositories your GitHub App can see.
2. **Scan project** — the server reads the repo through the GitHub API (read-only).
3. **Add game** — only now is a record saved, from a fresh server-side scan.

Connecting many games: **Games → Import many** finds Unity repositories automatically, hides the ones already connected, and imports your selection with progress, per-row errors and retry (see [Bulk import](#bulk-import)).

Phase 02 adds a real operations layer on top: **tests and Android/iOS builds started from the portal** (shared `unity-ci` workflows), live run status/errors, **artifact downloads**, **release readiness + candidates + manual approval**, **per-game AdMob configuration**, a **shared Unity ads module**, and an **AdMob revenue dashboard**. See [Phase 02 operations](#phase-02-operations).

Pages: **Overview · Games · Releases · Revenue**. Next.js 16 (App Router) · TypeScript · Tailwind 4 · Supabase (Postgres + Auth) · GitHub App · Vercel-compatible. No queues, workers, or extra services.

## What is real, and what is "Not configured"

| Field | Source | If it can't be found |
|---|---|---|
| Repository, default branch, latest commit | GitHub REST API | game cannot be added |
| Unity version / project path | `ProjectSettings/ProjectVersion.txt` (repo root, else nested search) | "Not detected" |
| Documentation | README / CHANGELOG / CLAUDE.md / GDD at root, files in `docs/` | "Not configured" |
| Test / Build / Publish workflows | `.github/workflows/*.yml` **file contents** (e.g. `game-ci/unity-test-runner`, `-buildTarget`, `upload-google-play`). Each workflow stores the signals that matched | "Not configured" |
| Latest workflow results | `actions/workflows/{id}/runs` on the **default branch** | "No runs yet" |
| Android / iOS readiness | A build workflow that explicitly targets that platform (`targetPlatform`/`-buildTarget`) + its latest run | "Not configured" |
| Monetization | Ad/IAP SDKs in `Packages/manifest.json` (AdMob, Unity IAP, LevelPlay, Unity Ads, AppLovin) — shown as "SDK detected", never "live" | "Not configured" |
| Publishing | A detected publishing workflow + its latest run. Store state is not read | "Not configured" |
| Type (Mini/Premium), development status | **You set these** — GitHub can't know | — |
| Revenue | Nothing yet. AdMob/IAP show "Not connected" | "Not connected" |

## Security model

- **Portal login:** Supabase Auth (email + password). Every route except `/login` is gated in `src/proxy.ts`, and every page/server action re-checks the session (`requireUser`).
- **No service-role key anywhere.** The app uses only the public anon key, acting as the signed-in user under Row Level Security (`supabase/migrations/0001_init.sql`). Anonymous users have no table access.
- **GitHub access: a GitHub App**, not a personal token. Permissions: *Metadata: read*, *Contents: read*, *Actions: read & write* (write only for manual triggers). The owner installs it on selected repositories only; the portal can't see anything else. Installation tokens are minted server-side from the App's private key (1 h, in-memory cache). Nothing GitHub-related reaches the browser.
- **Manual workflow runs:** only workflows that already exist and declare `workflow_dispatch`; always on the default branch; explicit confirmation dialog; workflows that look like store publishing additionally require typing the game name; every attempt is written to an audit table (`workflow_dispatches`). The portal never creates or edits workflows.
- **Removing a game** requires typing its name and only deletes the portal record — never the repo.

> RLS grants all signed-in users full access (single-tenant studio). **Turn off public sign-ups** in Supabase (step 3 below), otherwise anyone could register.

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Run `supabase/migrations/0001_init.sql` — paste it into the SQL editor, or `supabase link && supabase db push`.
3. **Authentication → Sign In / Providers →** turn **off** "Allow new users to sign up". Then **Authentication → Users → Add user** (tick *Auto Confirm*) for yourself and teammates.
4. **Project Settings → API:** copy the project URL and the **anon** key.

### 2. Create the GitHub App

GitHub → Settings (or the org's settings) → Developer settings → GitHub Apps → **New GitHub App**:

- Name: anything (e.g. `my-studio-portal`); Homepage URL: your portal URL (any URL works).
- **Webhook: uncheck "Active".** Leave "Request user authorization (OAuth)" unchecked — the portal doesn't use user-to-server tokens.
- Repository permissions: **Metadata: Read-only**, **Contents: Read-only**, **Actions: Read and write** *(choose Read-only if you never want to trigger runs from the portal; triggers will then fail with a clear error)*. Nothing else.
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

Unit/integration tests (no network): `npm test` — classifier, status derivation, App-JWT signing, the full scan pipeline against an in-memory GitHub fake, bulk-import discovery, duplicate handling and API route protection. `npm run typecheck` for types.

### 5. Deploy to Vercel

1. Push this folder to a Git repo and import it in Vercel (framework: Next.js, Node 22).
2. Add the env vars from `.env.example` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`; optionally `MASTER_PM_BASE_URL`). Mark the private key as **Sensitive**.
3. Deploy, sign in, and run the connection test locally against the same credentials (or open `/api/health` while signed in).

No GitHub webhook or callback URL is needed, so there's nothing to update after the first deploy.

## Bulk import

`/games/import` lists every repository the GitHub App can see, minus those already connected, and checks each (read-only, one API call per repo) for a `ProjectSettings` folder at the repository root. Only confirmed Unity repositories are listed by default, and nothing is preselected or imported until you choose. Detection shows a progress bar and the final count appears only when every repository has been checked. You can edit each game's name, type and status, or set type/status for all selected rows at once, then **Import**. Imports run 4 at a time; each row ends as *Added*, *Already connected*, *Not imported* (permanent: no Unity project, repository not found or inaccessible; not retryable) or *Failed* (possibly temporary, e.g. GitHub 5xx, rate limit, network; shown with the message and retryable). Each import does the same fresh server-side scan as the single-game wizard, and bulk import refuses any repository where that scan finds no Unity project (so reusable engine/tool repos can't be added by accident; use **Connect one game** if you really want one), and duplicates are impossible: `games.github_repo_id` is unique.

Unity projects inside subfolders aren't found by the quick check; tick **Show all repositories**, select them manually, and the import scan will locate the nested project.

The browser calls small route handlers (`/api/games/discover|import|refresh`) rather than Server Actions because Next dispatches Server Actions one at a time per client. The handlers require a same-origin JSON request and a valid Supabase session.

## Phase 02 operations

### Shared CI (the `unity-ci` repository)
Each game gets one ~30-line caller workflow (`workflow_dispatch` only) that calls the reusable workflow in the private `unity-ci` repo. The portal detects it (`uses: <owner>/unity-ci/…`), reads the allowed `action` choices, and shows **Builds & tests** on the game page: *Run EditMode / PlayMode tests*, *Build Android (dev)*, *Validate iOS*, *Self-test*. Every button opens a confirmation dialog; `android-release` additionally needs the game name typed. Nothing runs on push, nothing publishes, and no signing material is created.

- Runs on a **self-hosted Mac** (`["self-hosted","macOS","unity"]`) that has the needed Unity versions installed and activated. **Whether automated builds are allowed on your Unity licence tier is yours to confirm with Unity; the portal and workflows do not bypass or automate licensing.** Only the *Self-test* action runs on a GitHub-hosted runner (no Unity, ~1 minute of included minutes).
- Results come from GitHub (run, jobs, artifacts) plus a validated `portal-result.json` written by the workflow (test counts and failing test names, compile/build error summary, version, build number, duration, artifact SHA-256). Missing fields stay empty; nothing is invented. Runs of other workflows show status only.
- **Artifacts**: dev APKs kept 7 days. Download goes through `/api/artifacts/<game>/<id>` — authenticated, only artifacts recorded for that game, GitHub credentials never reach the browser.
- **Onboarding many games**: `tools/onboard.sh` (in `unity-ci`) opens one reviewable PR per repository using *your* `gh` login (dry run by default). The portal's Games list shows who is onboarded. The portal GitHub App stays read-mostly (no write access to game repositories).
- **Disk hygiene**: before Unity runs on a self-hosted runner, if free space is low the oldest *other* projects' `Library/` caches are removed (never sources). One build per repository at a time; one runner process runs one job at a time.
- **Retries/timeouts**: per-Unity-invocation timeout; one automatic retry only for known transient failures (Gradle daemon stopped).

### Release management (no publishing)
`Release readiness` on each game page evaluates Android and iOS from real data: tests on the latest commit, build + artifact present, release-signed AAB (a debug-signed APK always fails), placeholder bundle id/company, version/build number above the last approved release, target API, iOS validation, Apple team id, advertising safety. Each check is pass / fail / warning / unknown with its evidence. A **release candidate** is recorded from a successful build; a person can **approve** it (typed game name, refused while any check fails), **reject**, or record **published manually** after uploading to the store by hand. The portal never calls a store API.

### Advertising
Per game: **Advertising** page (AdMob app/ad-unit IDs per platform, test mode, frequency caps, banner, consent flags). Validation is enforced server-side (ID formats, one publisher per platform, no Google demo IDs in production). **Download StudioAdsConfig.json** → `Assets/Resources/StudioAdsConfig.json`. A batch action on the Revenue page creates safe test configs (disabled, test mode, Google demo IDs) for games without one. The Unity module `com.studio.ads` (in `unity-ci`) executes it: rewarded/interstitial/banner, caps, backoff retries, timeouts, UMP consent before any request, test mode by default. **AdMob apps and ad units are created in AdMob** — the AdMob API's create methods exist only in v1beta and make irreversible changes to your production account, so the portal does not use them.

### AdMob revenue (read-only)
Set `GOOGLE_OAUTH_CLIENT_ID/SECRET` and `ADMOB_TOKEN_ENCRYPTION_KEY` (see `.env.example`), register the redirect URI, then **Revenue → Connect AdMob** (scopes `admob.readonly` + `admob.report`, PKCE). Only the refresh token is stored, AES-256-GCM encrypted with a key that exists only in server env. **Sync now** pulls the last 30 days of network reports; revenue is attributed to a game only when its production AdMob app ID is set. Until connected the page says “Not connected”; eCPM is computed only when there are impressions.

### Checking it against real services
```bash
npm run test:connection                    # Supabase auth + RLS + every table (anonymous access must be denied); GitHub App
npm run test:ci-roundtrip -- owner/repo   # dispatches the SELF-TEST action via the GitHub App, waits, syncs, resolves an artifact download
```
With the dev server running and **you signed in in your own browser**, open these (read-only unless noted); results are shown and also written to the server log with a `[selftest]` prefix:
- `/api/health?deep=1` — schema state (is migration 0002 applied?), configuration, and every page rendering with your session.
- `/api/health?exercise=owner/repo` — **dev only**: connects the repo (or reuses it), dispatches the self-test through the portal's own action, waits, checks the parsed result and artifact download, proves the Unity gate refuses Unity actions, exercises ad-config validation/persistence/export, then removes the test game it created. Uses ~10–15 s of included hosted minutes. Disabled when `NODE_ENV=production`.

### Unity automation gate
`UNITY_AUTOMATION_ALLOWED` (default `false`). While it is not exactly `true`, the portal refuses every Unity action (tests, Android, iOS) on the server and disables the buttons; the Unity-free **Self-test** still works. Flip it only after confirming with Unity that automated builds are permitted under your licence.

### AdMob OAuth: the Google Cloud steps that cannot be automated
1. Google Cloud Console → create or pick a project → *APIs & Services ▸ Library* → enable **AdMob API**.
2. *Google Auth platform* (OAuth consent screen): user type **External**, fill the app name/email, add the AdMob owner as a test user, then set **Publishing status = In production**. In *Testing* status Google expires the refresh token after **7 days** (Google OAuth docs), and you would have to reconnect weekly. (An unverified-app warning screen appears for one-person use; accept it.)
3. *Credentials ▸ Create credentials ▸ OAuth client ID ▸ Web application*; add the authorized redirect URI `http://localhost:3000/api/integrations/admob/callback` (plus `https://YOUR-DOMAIN/api/integrations/admob/callback` once deployed). Download the JSON.
4. Put the client ID/secret into `.env.local` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (`ADMOB_TOKEN_ENCRYPTION_KEY` is already generated), restart the dev server, then **Revenue ▸ Connect AdMob** with the Google account that owns the AdMob account.

## Master Game PM boundary

`src/lib/integrations/master-pm.ts` is the only place the portal may talk about Master Game PM. Today it only builds a deep link from `MASTER_PM_BASE_URL` + a per-game `pm_ref` (editable on the game page). It never reads, writes or deletes anything in the PM project.

## Revenue (prepared, not connected)

`src/lib/revenue/types.ts` defines `RevenueProvider` (`connection()`, `fetchRevenue()`); `providers.ts` registers AdMob and IAP placeholders that always report `not_connected`. Implement a provider there and the page switches to "Connected" — no figures exist until then.

## Layout

```
supabase/migrations/   schema + RLS
src/proxy.ts           session refresh + route protection
src/lib/github/        app auth, scanner, classifier, dispatch (server-only)
src/lib/status.ts      derived statuses ("not configured" unless evidenced)
src/app/(portal)/      Overview, Games (+ connect wizard, detail), Releases, Revenue
scripts/connection-test.ts
tests/
```

## Known limitations

- **Phase 02 verification status.** Verified for real: GitHub-App dispatch → hosted run → validated result → artifact → signed download URL (self-test action, pilot repo); Unity 6000.6.3f1 EditMode tests, Android APK and AAB export, and iOS export through `unity_ci.py` on the isolated pilot; the ads module's 32 Unity tests and compilation of the Google adapter against `com.google.ads.mobile` 11.5.0. **Not verified**: a Unity job on a GitHub runner (no runner is installed and the Unity licence question is open), real ad display (needs a device), the live AdMob OAuth/report calls (need your Google credentials; tested against recorded response shapes), and the portal UI with your real Supabase session.
- **MVP 01 status.** Verified against the real services: Supabase auth + RLS (`npm run test:connection`), GitHub App authentication and scanning, adding a real game and reloading it. Bulk import was verified live for discovery and against fakes for the import/retry UI.
- **Classification is heuristic.** It reads workflow YAML for known signals. Workflows that call the studio's shared `unity-ci` are recognised; other pipelines that hide Unity/Fastlane calls inside other reusable workflows, composite actions, or external scripts will show "Not configured" for what they do. Hover a workflow's detail line to see the signals that matched.
- **"Ready" means evidence, not guarantees.** Release readiness reflects recorded CI runs and ProjectSettings facts; store listings, signing key custody, Play/App Store policies and the actual upload are outside it (publishing is manual).
- **Monetization is SDK presence** in the manifest (and only for the first Unity project found); it doesn't prove ads are live. **Publishing status** doesn't read store state.
- **Type and development status are manual.**
- **Snapshots, no webhooks.** Data is as fresh as the last Refresh (per game, or "Refresh all", which runs 4 games at a time from the browser via `/api/games/refresh` to stay inside serverless time limits; ~8 GitHub calls per game). Status after a manual run is a best-effort refresh 2.5 s later.
- **Runs shown are for the default branch only.** Runs on feature branches are ignored.
- **Manual triggers:** default branch only, no workflow inputs (workflows with required inputs are blocked), no cancel/re-run.
- **Nested Unity projects:** the shallowest `ProjectSettings` is used; in huge monorepos the recursive tree may be truncated and only the repo root is checked (noted on the game).
- **Single-tenant, one role.** All signed-in users can do everything; auth is email + password only (no SSO/MFA setup in the app, though Supabase MFA can be enabled separately). The games list isn't paginated (fine for ~150).
- GitHub App tokens are cached per server instance; GitHub rate limits (5 000+/h per installation) apply — a full 150-game refresh is ~1 200 requests.
- **Build capacity**: one Mac, one runner = one job at a time; other Unity/Gradle users on that Mac can disturb builds (observed once in M0). A dedicated macOS user/machine is recommended; the Unity Personal licence is per macOS user.
- **Unity licensing for automation is unresolved** (your decision with Unity). Until confirmed, do not run the Unity actions from the portal; the self-test action is always safe.
- **Android release (AAB) and iOS IPA signing are not set up**: `android-release` fails fast without the keystore variables on the runner; iOS validation is unsigned. No signing material is created by the portal or workflows.
- **Ads**: real ad display is untested (needs a device); the adapter targets Google Mobile Ads Unity plugin 11.x (callbacks are marshalled to the main thread because 11.x raises them off-thread). iOS also needs the ATT prompt and usage string, which are yours to add.
- **AdMob revenue** shows data only after you authorize Google and map each game's production app ID; the report API's timezone is fixed to America/Los_Angeles; IAP revenue is not connected.
- **Artifacts**: GitHub's 500 MB (Free) artifact quota holds only a handful of APKs at 7-day retention; the portal does not copy artifacts elsewhere.
- **AdMob connection status: BLOCKED on Google's side (diagnosed 2026-10-11).** OAuth completes (code exchange succeeds; `tokeninfo` confirms a fresh token with `admob.readonly` + `admob.report` and the right audience), but `GET /v1/accounts` answers **HTTP 401 UNAUTHENTICATED** from the AdMob backend (no `reason`, no `WWW-Authenticate`). The request is byte-for-byte what Google's official client library sends. Google documents this 401 as "the access token isn't authorized for the account"; `accounts.list` returns "the publisher account most recently signed in to from the AdMob UI". Nothing in the portal can fix this; it needs a successful API call from the AdMob account holder's side (see the evidence in the dev-server log, `[admob]` lines).
