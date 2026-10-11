"use client";

import { useEffect, useState, useTransition } from "react";

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
  const [elapsed, setElapsed] = useState(0);
  const [label, setLabel] = useState("");

  // Show the last result again after a reload (the server also logs every run with a [selftest] prefix).
  useEffect(() => {
    try { const saved = sessionStorage.getItem("system-check-last"); if (saved) setResult(JSON.parse(saved) as Result); } catch { /* storage unavailable */ }
  }, []);
  // Visible heartbeat so a long run never looks frozen.
  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [pending]);

  const run = (query: string, what: string) => start(async () => {
    setError(null); setLabel(what);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6 * 60_000); // never wait forever
    try {
      const res = await fetch(`/api/health?${query}`, { cache: "no-store", signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? " (session expired — sign in again)" : ""}`);
      const json = (await res.json()) as Result;
      setResult(json);
      try { sessionStorage.setItem("system-check-last", JSON.stringify(json)); } catch { /* ignore */ }
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "Timed out after 6 minutes. Check the dev-server log for [selftest] lines." : e instanceof Error ? e.message : "Request failed");
    } finally {
      clearTimeout(timer);
    }
  });

  return (
    <>
      <div className="card flex flex-wrap items-center gap-2 p-4">
        <button className="btn btn-primary" disabled={pending} onClick={() => run("deep=1", "checks")}>{pending && label === "checks" ? `Running… ${elapsed}s` : "Run checks"}</button>
        {canExercise && (
          <>
            <input className="input max-w-xs" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo (a Unity repo with the shared CI)" aria-label="Repository for the end-to-end test" />
            <button className="btn" disabled={pending || !/^[\w.-]+\/[\w.-]+$/.test(repo)} onClick={() => run(`exercise=${encodeURIComponent(repo)}`, "e2e")}>{pending && label === "e2e" ? `Running… ${elapsed}s` : "Run end-to-end test"}</button>
          </>
        )}
        {pending && <p role="status" className="w-full text-sm text-muted">{label === "e2e" ? "The end-to-end test usually takes 30–90 seconds (up to ~2 minutes on the first run while the dev server compiles pages). Keep this tab open; the result appears here and in the server log." : "Checking every page with your session — about 30 seconds on the dev server."}</p>}
        <p className="w-full text-xs text-muted">“Run checks” is read-only. The end-to-end test (development server only) connects the repo temporarily, dispatches the Unity-free self-test (~15 s of hosted minutes), checks results, artifact download and advertising config, then removes the test game again. It never runs Unity.</p>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-[var(--bad-fg)]">{error}</p>}
      {result?.supabase && <p className="mt-4 text-sm text-muted">Supabase: {result.supabase.ok ? `OK (${result.supabase.games} games)` : result.supabase.error} · GitHub: {result.github?.ok ? "OK" : result.github?.error}</p>}
      {result?.deep && <List title="Checks" steps={result.deep} />}
      {result?.exercise && <List title="End-to-end test" steps={result.exercise} />}
    </>
  );
}
