"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui";
import type { PlanAction, PlanItem } from "@/lib/ads/integration";
import { applyIdImportAction, previewIdImportAction } from "../[id]/ads/actions";

const TONE: Record<PlanAction, "good" | "warn" | "bad" | "muted"> = { create: "good", fill: "good", same: "muted", needs_approval: "warn", conflict: "bad", unknown_game: "bad" };
const LABEL: Record<PlanAction, string> = { create: "New", fill: "Fill", same: "Unchanged", needs_approval: "Needs approval", conflict: "Conflict", unknown_game: "Unknown game" };
const EXAMPLE = "game,platform,app_id,banner,interstitial,rewarded\nowner/repo,android,ca-app-pub-0000000000000000~0000000000,ca-app-pub-0000000000000000/0000000000,ca-app-pub-0000000000000000/0000000000,ca-app-pub-0000000000000000/0000000000";

export function ImportIds() {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const preview = () => start(async () => {
    setMsg(null);
    const r = await previewIdImportAction(text);
    if (!r.ok) { setMsg(r.error); setPlan(null); return; }
    setPlan(r.plan); setErrors(r.errors); setApproved(new Set());
  });
  const apply = () => start(async () => {
    const r = await applyIdImportAction(text, [...approved]);
    if (!r.ok) { setMsg(r.error); return; }
    setMsg(`Applied ${r.applied} row(s); ${r.skipped} skipped. Ads stay disabled and in test mode.`);
    setPlan(null);
  });
  const applicable = plan?.filter((p) => p.action === "create" || p.action === "fill" || (p.action === "needs_approval" && approved.has(p.line))).length ?? 0;

  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium">IDs (CSV or tab separated)
        <textarea className="input mt-1 h-40 font-mono text-xs" value={text} onChange={(e) => { setText(e.target.value); setPlan(null); }} placeholder={EXAMPLE} spellCheck={false} />
      </label>
      <p className="text-xs text-muted">Columns: game (owner/repo), platform (android|ios), app ID, banner, interstitial, rewarded. Each game needs its own IDs; an ID that another game uses is rejected.</p>
      <button className="btn" onClick={preview} disabled={pending || !text.trim()}>{pending ? "Working…" : "Preview"}</button>
      {msg && <p className="text-sm" role="status">{msg}</p>}
      {errors.length > 0 && <ul className="text-sm text-bad">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {plan && (
        <div className="card p-4">
          <ul className="divide-y divide-line text-sm">
            {plan.map((p) => (
              <li key={p.line} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0"><span className="font-medium">{p.game}</span> <span className="text-muted">{p.platform}</span><span className="block text-xs text-muted">{p.message}</span></span>
                <span className="flex items-center gap-2">
                  {p.action === "needs_approval" && (
                    <label className="text-xs"><input type="checkbox" checked={approved.has(p.line)} onChange={(e) => setApproved((s) => { const n = new Set(s); if (e.target.checked) n.add(p.line); else n.delete(p.line); return n; })} /> overwrite</label>
                  )}
                  <Badge tone={TONE[p.action]}>{LABEL[p.action]}</Badge>
                </span>
              </li>
            ))}
          </ul>
          <button className="btn mt-3" onClick={apply} disabled={pending || applicable === 0}>Apply {applicable} row(s)</button>
        </div>
      )}
    </div>
  );
}
