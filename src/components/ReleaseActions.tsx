"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { createCandidateAction, decideReleaseAction } from "@/app/(portal)/releases/release-actions";
import type { ReleaseRow } from "@/lib/types";

type RunOption = { id: string; label: string };

/** Creates a release candidate from a real successful build. Records it only; nothing is uploaded or published. */
export function CandidateCreator({ gameId, platform, runs }: { gameId: string; platform: "android" | "ios"; runs: RunOption[] }) {
  const router = useRouter();
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (runs.length === 0) return <p className="text-xs text-muted">No successful {platform === "android" ? "Android build" : "iOS validation"} to record yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="input w-auto max-w-full text-xs" value={runId} onChange={(e) => setRunId(e.target.value)} aria-label={`Build to record as ${platform} candidate`}>
        {runs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      <button className="btn text-xs" disabled={pending || !runId} onClick={() => start(async () => {
        const res = await createCandidateAction({ gameId, runId, platform });
        if (!res.ok) return setError(res.error);
        setError(null); router.refresh();
      })}>{pending ? "Recording…" : "Record candidate"}</button>
      {error && <span role="alert" className="text-xs text-[var(--bad-fg)]">{error}</span>}
    </div>
  );
}

/** Approve / reject / mark-published-manually, each behind a typed-name confirmation. No store API is ever called. */
export function ReleaseActions({ release, gameName }: { release: Pick<ReleaseRow, "id" | "status" | "version" | "build_number" | "platform">; gameName: string }) {
  const router = useRouter();
  const dlg = useRef<HTMLDialogElement>(null);
  const [decision, setDecision] = useState<"approve" | "reject" | "published_manually">("approve");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const open = (d: typeof decision) => { setDecision(d); setTyped(""); setError(null); dlg.current?.showModal(); };

  const buttons: { d: typeof decision; label: string }[] =
    release.status === "candidate" ? [{ d: "approve", label: "Approve" }, { d: "reject", label: "Reject" }]
    : release.status === "approved" ? [{ d: "published_manually", label: "Mark published manually" }, { d: "reject", label: "Revoke (reject)" }] : [];
  if (buttons.length === 0) return null;

  const text = {
    approve: "Approving records that a person accepted this build for release. It does NOT publish anything.",
    reject: "Rejecting marks this candidate as not to be released.",
    published_manually: "Only record this after YOU uploaded the build to the store by hand. The portal never publishes.",
  }[decision];

  return (
    <>
      <span className="flex flex-wrap gap-1">{buttons.map((b) => <button key={b.d} className="btn !px-2 !py-1 text-xs" onClick={() => open(b.d)}>{b.label}</button>)}</span>
      <dialog ref={dlg} className="m-auto w-[min(92vw,28rem)] rounded-xl border border-line bg-surface p-5 text-fg backdrop:bg-black/50">
        <h2 className="text-base font-semibold">{decision === "approve" ? "Approve" : decision === "reject" ? "Reject" : "Mark as published manually"} {release.platform} v{release.version} ({release.build_number})?</h2>
        <p className="mt-2 text-sm text-muted">{text}</p>
        <input className="input mt-3" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={gameName} aria-label="Type the game name to confirm" />
        {error && <p role="alert" className="mt-2 text-sm text-[var(--bad-fg)]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={() => dlg.current?.close()} disabled={pending}>Cancel</button>
          <button className="btn btn-primary" disabled={pending || typed.trim() !== gameName} onClick={() => start(async () => {
            const res = await decideReleaseAction({ releaseId: release.id, decision, typedName: typed });
            if (!res.ok) return setError(res.error);
            dlg.current?.close(); router.refresh();
          })}>{pending ? "Saving…" : "Confirm"}</button>
        </div>
      </dialog>
    </>
  );
}
