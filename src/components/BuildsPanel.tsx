import { CI_ACTION_META, isCiAction, knownActions, type CiAction } from "@/lib/ci/actions";
import { unityBlockedReason } from "@/lib/ci/policy";
import { fmtDuration, fmtMB } from "@/lib/ci/format";
import { triggerDisabledReason } from "@/lib/workflow-trigger";
import type { BuildRunRow, GameRow, WorkflowRow } from "@/lib/types";
import { Badge, timeAgo } from "./ui";
import { TriggerButton } from "./TriggerButton";

function statusOf(r: BuildRunRow): { tone: "good" | "bad" | "info" | "warn" | "muted"; text: string } {
  if (r.status !== "completed") return { tone: "info", text: r.status === "queued" ? "Queued" : "Running" };
  if (r.conclusion === "success") return { tone: "good", text: "Success" };
  if (r.conclusion === "failure" || r.conclusion === "timed_out") return { tone: "bad", text: r.conclusion === "timed_out" ? "Timed out" : "Failed" };
  return { tone: "warn", text: (r.conclusion ?? "Done").replace(/_/g, " ") };
}

const newest = (rs: BuildRunRow[]) => [...rs].sort((a, b) => Date.parse(b.started_at ?? "0") - Date.parse(a.started_at ?? "0"))[0];

function RunSummary({ game, run, empty }: { game: GameRow; run: BuildRunRow | undefined; empty: string }) {
  if (!run) return <p className="text-sm text-muted">{empty}</p>;
  const st = statusOf(run);
  const t = run.summary?.tests;
  const arts = run.artifacts.filter((a) => !a.expired);
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <Badge tone={st.tone}>{st.text}</Badge>
        {run.html_url && <a href={run.html_url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:underline">run #{run.run_number}</a>}
      </div>
      <p className="mt-1 text-xs text-muted">
        <span className="font-mono">{run.head_sha?.slice(0, 7)}</span>{run.head_sha && game.commit_sha && run.head_sha !== game.commit_sha ? " (not latest)" : ""} · {timeAgo(run.started_at)} · {fmtDuration(run.duration_s)}
        {run.version && <> · v{run.version}{run.build_number !== null && ` (${run.build_number})`}</>}
      </p>
      {t && (
        <p className="mt-1">
          {t.passed}/{t.total} passed{t.failed > 0 && <span className="text-[var(--bad-fg)]"> · {t.failed} failed</span>}{t.skipped > 0 && <span className="text-muted"> · {t.skipped} skipped</span>}
        </p>
      )}
      {t && t.failures.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-[var(--bad-fg)]">{t.failures.slice(0, 3).map((f) => <li key={f.name} className="break-words">{f.name}</li>)}</ul>
      )}
      {run.conclusion && run.conclusion !== "success" && (run.summary?.errorSummary || run.failed_step) && (
        <p className="mt-1 break-words text-xs text-[var(--bad-fg)]">{run.summary?.errorSummary ?? `Failed at “${run.failed_step}”`}</p>
      )}
      {arts.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {arts.map((a) => (
            <li key={a.id}>
              <a className="btn !px-2 !py-1 text-xs" href={`/api/artifacts/${game.id}/${a.id}`} title={a.expires_at ? `Expires ${new Date(a.expires_at).toLocaleDateString()}` : undefined}>
                Download {a.name} · {fmtMB(a.size_bytes)}
              </a>
            </li>
          ))}
        </ul>
      )}
      {run.artifacts.length > 0 && arts.length === 0 && <p className="mt-1 text-xs text-muted">Artifacts expired.</p>}
    </div>
  );
}

export function BuildsPanel({ game, workflows, runs }: { game: GameRow; workflows: WorkflowRow[]; runs: BuildRunRow[] }) {
  const ci = workflows.find((w) => w.ci_ref);
  const real = runs.filter((r) => r.action !== "smoke");
  const by = (actions: CiAction[]) => newest(real.filter((r) => r.action && actions.includes(r.action)));
  const actions = ci ? knownActions(ci.ci_actions) : [];

  return (
    <section className="card mt-4" aria-labelledby="builds-h">
      <h2 id="builds-h" className="border-b border-line px-4 py-3 text-sm font-semibold">Builds & tests</h2>
      {!ci ? (
        <div className="px-4 py-6 text-sm text-muted">
          <p><strong className="text-fg">Not onboarded</strong> to the shared studio CI — there is no caller workflow in this repository, so there is nothing to run.</p>
          <p className="mt-1">Onboarding opens one reviewable pull request: <code>tools/onboard.sh --apply {game.full_name}</code> (in the <code>unity-ci</code> repository). Nothing is changed until you merge it.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 p-4 md:grid-cols-3">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Tests</h3>
              <div className="flex flex-col gap-3">
                {(["test-editmode", "test-playmode"] as const).map((a) => (
                  <div key={a}><p className="mb-1 text-xs text-muted">{CI_ACTION_META[a].label}</p><RunSummary game={game} run={by([a])} empty="No run yet." /></div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Android</h3>
              <RunSummary game={game} run={by(["android-dev", "android-release"])} empty="No Android build yet." />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">iOS</h3>
              <RunSummary game={game} run={by(["ios-validate"])} empty={actions.includes("ios-validate") ? "No iOS validation yet." : "Not configured (this repository's CI does not offer iOS validation)."} />
            </div>
          </div>

          {unityBlockedReason("test-editmode") && actions.some((a) => a !== "smoke") && (
            <p className="border-t border-line bg-[var(--warn-bg)] px-4 py-2 text-xs text-[var(--warn-fg)]">Unity actions are switched off until the Unity licence question is resolved (server setting <code>UNITY_AUTOMATION_ALLOWED</code>). Only the Self-test can run.</p>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            {actions.map((a) => (
              <TriggerButton key={a} workflowRowId={ci.id} workflowName={ci.name} gameName={game.name} branch={game.default_branch} isPublish={false}
                action={a} label={CI_ACTION_META[a].button} note={CI_ACTION_META[a].note} typedConfirm={CI_ACTION_META[a].typedConfirm}
                disabledReason={triggerDisabledReason(ci, game.is_archived) ?? unityBlockedReason(a)} />
            ))}
            <span className="w-full text-xs text-muted lg:ml-auto lg:w-auto lg:max-w-md lg:text-right">Runs on the build Mac (self-hosted): $0 GitHub minutes. “Self-test” runs on a hosted runner and uses ~1 minute of included minutes.</span>
          </div>

          {runs.length > 0 && (
            <ul className="divide-y divide-line border-t border-line">
              {runs.slice(0, 8).map((r) => {
                const st = statusOf(r);
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">{r.action && isCiAction(r.action) ? CI_ACTION_META[r.action].label : r.title ?? "Run"}<span className="text-muted"> · <span className="font-mono text-xs">{r.head_sha?.slice(0, 7)}</span> · {r.head_branch}</span></span>
                    <span className="flex items-center gap-2 text-xs text-muted">{timeAgo(r.started_at)} · {fmtDuration(r.duration_s)} <Badge tone={st.tone}>{st.text}</Badge>{r.html_url && <a href={r.html_url} target="_blank" rel="noreferrer" className="underline">log</a>}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
