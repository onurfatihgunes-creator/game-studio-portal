"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { refreshGameAction } from "@/app/(portal)/games/actions";

/** Refreshes games a few at a time from the browser so no single request exceeds serverless time limits. */
export function RefreshAll({ gameIds }: { gameIds: string[] }) {
  const router = useRouter();
  const [progress, setProgress] = useState<{ done: number; failed: number } | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setProgress({ done: 0, failed: 0 });
    const queue = [...gameIds];
    let done = 0;
    let failed = 0;
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const r = await refreshGameAction(id).catch(() => ({ ok: false as const }));
        done++;
        if (!r.ok) failed++;
        setProgress({ done, failed });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, gameIds.length) }, worker));
    setRunning(false);
    router.refresh();
  }

  return (
    <button type="button" className="btn" onClick={run} disabled={running || gameIds.length === 0}>
      {running && progress ? `Refreshing ${progress.done}/${gameIds.length}…` : progress ? `Refreshed ${progress.done - progress.failed}/${gameIds.length}${progress.failed ? ` · ${progress.failed} failed` : ""}` : "Refresh all"}
    </button>
  );
}
