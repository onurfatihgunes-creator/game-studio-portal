# Game Studio Portal — MVP 01

A small web portal for tracking a portfolio of Unity mobile games. Connect a game from GitHub in three steps:

1. **Select repository** — pick from the repositories your GitHub App can see.
2. **Scan project** — the server reads the repo through the GitHub API (read-only).
3. **Add game** — only now is a record saved, from a fresh server-side scan.

Connecting many games: **Games → Import many** finds Unity repositories automatically, hides the ones already connected, and imports your selection with progress, per-row errors and retry (see [Bulk import](#bulk-import)).

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

- **Not yet exercised against your live accounts.** In development I verified types, the production build, unit/integration tests, and the UI (including the connect wizard through the scan step) against *fake* GitHub and Supabase servers. The final database write ("Add game"), real GitHub responses, and real RLS are untested until you run `npm run test:connection` and connect a game with your credentials.
- **Classification is heuristic.** It reads workflow YAML for known signals. Pipelines that hide Unity/Fastlane calls inside reusable workflows (`uses: ./.github/workflows/x.yml`), composite actions, or external scripts will show "Not configured" for what they do. Hover a workflow's detail line to see the signals that matched.
- **"Ready" means evidence, not guarantees.** Android/iOS readiness only reflects a build workflow that names the platform and its latest result. Signing keys, store listings, and bundle settings aren't checked.
- **Monetization is SDK presence** in the manifest (and only for the first Unity project found); it doesn't prove ads are live. **Publishing status** doesn't read store state.
- **Type and development status are manual.**
- **Snapshots, no webhooks.** Data is as fresh as the last Refresh (per game, or "Refresh all", which runs 4 games at a time from the browser via `/api/games/refresh` to stay inside serverless time limits; ~8 GitHub calls per game). Status after a manual run is a best-effort refresh 2.5 s later.
- **Runs shown are for the default branch only.** Runs on feature branches are ignored.
- **Manual triggers:** default branch only, no workflow inputs (workflows with required inputs are blocked), no cancel/re-run.
- **Nested Unity projects:** the shallowest `ProjectSettings` is used; in huge monorepos the recursive tree may be truncated and only the repo root is checked (noted on the game).
- **Single-tenant, one role.** All signed-in users can do everything; auth is email + password only (no SSO/MFA setup in the app, though Supabase MFA can be enabled separately). The games list isn't paginated (fine for ~150).
- GitHub App tokens are cached per server instance; GitHub rate limits (5 000+/h per installation) apply — a full 150-game refresh is ~1 200 requests.
