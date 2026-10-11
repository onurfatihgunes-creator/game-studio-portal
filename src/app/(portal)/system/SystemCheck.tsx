"use client";

import { useState, useTransition } from "react";

type Step = { name: string; ok: boolean; detail: string };
type Result = { supabase?: { ok: boolean; error?: string; games?: number }; github?: { ok: boolean; error?: string }; deep?: Step[]; exercise?: Step[] };

function List({ title, steps }: { title: string; steps: Step[] }) {
  const pass = steps.filter((s) => s.ok).length;
  return (
    <section className="card mt-4">
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">{title} <span className="font-normal text-muted">· {pass}/{steps.length} passed</span></h2>
      <ul className="divide-y divide-line text-sm">
        {steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[3.5rem_1fr] gap-2 px-4 py-2">
            <span className={`font-semibold ${s.ok ? "text-[var(--good-fg)]" : "text-[var(--bad-fg)]"}`}>{s.ok ? "PASS" : "FAIL"}</span>
            <span><span>{s.name}</span><span className="block break-words text-xs text-muted">{s.detail}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Runs the authenticated checks from inside the portal (no URL typing). Results are also written to the server log. */
export function SystemCheck({ defaultRepo, canExercise }: { defaultRepo: string; canExercise: boolean }) {
  const [repo, setRepo] = useState(defaultRepo);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (query: string) => start(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/health?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult((await res.json()) as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  });

  return (
    <>
      <div className="card flex flex-wrap items-center gap-2 p-4">
        <button className="btn btn-primary" disabled={pending} onClick={() => run("deep=1")}>{pending ? "Running…" : "Run checks"}</button>
        {canExercise && (
          <>
            <input className="input max-w-xs" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo (a Unity repo with the shared CI)" aria-label="Repository for the end-to-end test" />
            <button className="btn" disabled={pending || !/^[\w.-]+\/[\w.-]+$/.test(repo)} onClick={() => run(`deep=1&exercise=${encodeURIComponent(repo)}`)}>Run end-to-end test</button>
          </>
        )}
        <p className="w-full text-xs text-muted">“Run checks” is read-only. The end-to-end test (development server only) connects the repo temporarily, dispatches the Unity-free self-test (~15 s of hosted minutes), checks results, artifact download and advertising config, then removes the test game again. It never runs Unity.</p>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-[var(--bad-fg)]">{error}</p>}
      {result?.supabase && <p className="mt-4 text-sm text-muted">Supabase: {result.supabase.ok ? `OK (${result.supabase.games} games)` : result.supabase.error} · GitHub: {result.github?.ok ? "OK" : result.github?.error}</p>}
      {result?.deep && <List title="Checks" steps={result.deep} />}
      {result?.exercise && <List title="End-to-end test" steps={result.exercise} />}
    </>
  );
}
