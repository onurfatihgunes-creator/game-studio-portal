import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { listAllAccessibleRepos, listInstallations, readGitHubConfig, type RepoSummary } from "@/lib/github/app";
import { requireUser } from "@/lib/supabase/server";
import { ConnectWizard } from "./ConnectWizard";

export const metadata: Metadata = { title: "Connect game" };

export default async function NewGamePage() {
  const { supabase } = await requireUser();
  const cfg = readGitHubConfig();

  if (!cfg.ok) {
    return (
      <>
        <PageHeader title="Connect a game" />
        <EmptyState title="GitHub is not configured">
          Missing server environment variable{cfg.missing.length > 1 ? "s" : ""}: <code>{cfg.missing.join(", ")}</code>.
          Follow “Create the GitHub App” in the README, then restart the server.
        </EmptyState>
      </>
    );
  }

  let repos: RepoSummary[] = [];
  let installCount = 0;
  let error: string | null = null;
  try {
    [repos, installCount] = await Promise.all([listAllAccessibleRepos(cfg.config), listInstallations(cfg.config).then((i) => i.length)]);
  } catch (e) {
    error = e instanceof Error ? e.message : "GitHub request failed";
  }

  const { data: connected } = await supabase.from("games").select("github_repo_id, id");
  const connectedMap: Record<number, string> = Object.fromEntries((connected ?? []).map((g) => [g.github_repo_id, g.id]));
  const installUrl = cfg.config.slug ? `https://github.com/apps/${cfg.config.slug}/installations/new` : null;

  return (
    <>
      <PageHeader title="Connect a game" subtitle="Select a repository, scan it, then add it. Nothing is saved until GitHub has answered." />
      {error ? (
        <EmptyState title="Could not reach GitHub">
          <p className="text-[var(--bad-fg)]">{error}</p>
          <p className="mt-2">Check <code>GITHUB_APP_ID</code> and <code>GITHUB_APP_PRIVATE_KEY</code>, then reload.</p>
        </EmptyState>
      ) : installCount === 0 ? (
        <EmptyState title="The GitHub App is not installed anywhere yet">
          Install it on your account or organization and grant access to the game repositories.
          {installUrl && <div className="mt-4"><a className="btn btn-primary" href={installUrl} target="_blank" rel="noreferrer">Install GitHub App</a></div>}
        </EmptyState>
      ) : (
        <ConnectWizard repos={repos} connected={connectedMap} installUrl={installUrl} />
      )}
      <p className="mt-6 text-sm"><Link href="/games" className="text-muted hover:underline">← Back to games</Link></p>
    </>
  );
}
