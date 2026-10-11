"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { triggerWorkflowAction } from "@/app/(portal)/releases/actions";

type Props = {
  workflowRowId: string;
  workflowName: string;
  gameName: string;
  branch: string;
  isPublish: boolean;
  /** When set, the button is disabled and this explains why. */
  disabledReason?: string | null;
  /** Shared studio CI: the dispatch input `action` this button sends. */
  action?: string;
  /** Button text (defaults to "Run"), a short description of what will run, and typed-name confirmation for release builds. */
  label?: string;
  note?: string;
  typedConfirm?: boolean;
};

/** Explicit confirmation before any manual run. Publishing-style workflows require typing the game name. */
export function TriggerButton({ workflowRowId, workflowName, gameName, branch, isPublish, disabledReason, action, label, note, typedConfirm }: Props) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = () => { setError(null); setTyped(""); dialog.current?.showModal(); };
  const close = () => dialog.current?.close();
  const needsTyped = isPublish || !!typedConfirm;
  const canConfirm = !pending && (!needsTyped || typed.trim() === gameName);

  const confirm = () =>
    start(async () => {
      const res = await triggerWorkflowAction({ workflowRowId, confirmed: true, typedGameName: typed, action });
      if (!res.ok) return setError(res.error);
      close();
      router.refresh();
    });

  return (
    <>
      <button className="btn" onClick={open} disabled={!!disabledReason} title={disabledReason ?? "Run this workflow on GitHub"}>{label ?? "Run"}</button>
      <dialog ref={dialog} className="m-auto w-[min(92vw,28rem)] rounded-xl border border-line bg-surface p-5 text-fg backdrop:bg-black/50">
        <h2 className="text-base font-semibold">{action ? `${label ?? action}?` : `Run “${workflowName}”?`}</h2>
        <p className="mt-2 text-sm text-muted">
          This starts a real GitHub Actions run for <strong className="text-fg">{gameName}</strong> on branch <code>{branch}</code>.
          {note ? <> {note}</> : <> It may consume build minutes.</>}
        </p>
        {needsTyped && (
          <div className="mt-3 rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">
            {isPublish ? <>This workflow looks like it <strong>publishes to a store</strong>.</> : <>This prepares a <strong>release build</strong> (nothing is published).</>} Type the game name to confirm.
            <input className="input mt-2" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={gameName} aria-label="Type the game name to confirm" />
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--bad-fg)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn" onClick={close} disabled={pending}>Cancel</button>
          <button className="btn btn-primary" onClick={confirm} disabled={!canConfirm}>{pending ? "Starting…" : "Run workflow"}</button>
        </div>
      </dialog>
    </>
  );
}
