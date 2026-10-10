import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui";
import { listAllAccessibleRepos, readGitHubConfig, type RepoSummary } from "@/lib/github/app";
import { requireUser } from "@/lib/supabase/server";
import { ImportClient } from "./ImportClient";

export const metadata: Metadata = { title: "Import games" };

export default async function ImportPage() {
  const { supabase } = await requireUser();
  const cfg = readGitHubConfig();

  const header = <PageHeader title="Import games" subtitle="Find Unity repositories and add many at once." actions={<Link href="/games/new" className="btn">Connect one game</Link>} />;

  if (!cfg.ok) {
    return (<>{header}<EmptyState title="GitHub is not configured">Missing: <code>{cfg.missing.join(", ")}</code>.</EmptyState></>);
  }

  let repos: RepoSummary[] = [];
  let error: string | null = null;
  try {
    repos = await listAllAccessibleRepos(cfg.config);
  } catch (e) {
    error = e instanceof Error ? e.message : "GitHub request failed";
  }
  if (error) return (<>{header}<EmptyState title="Could not reach GitHub"><span className="text-[var(--bad-fg)]">{error}</span></EmptyState></>);

  const { data } = await supabase.from("games").select("github_repo_id");
  const connected = new Set((data ?? []).map((g) => Number(g.github_repo_id)));
  const available = repos.filter((r) => !connected.has(r.id));

  return (
    <>
      {header}
      {available.length === 0 ? (
        <EmptyState title="Nothing to import">
          {repos.length === 0 ? "The GitHub App can't see any repositories yet." : `All ${repos.length} accessible repositories are already connected.`}
        </EmptyState>
      ) : (
        <ImportClient repos={available} alreadyConnected={repos.length - available.length} />
      )}
      <p className="mt-6 text-sm"><Link href="/games" className="text-muted hover:underline">← Back to games</Link></p>
    </>
  );
}
