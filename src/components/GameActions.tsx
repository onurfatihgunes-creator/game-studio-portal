"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { refreshGameAction, removeGameAction, updateGameAction } from "@/app/(portal)/games/actions";
import { DEV_STATUSES, DEV_STATUS_LABEL, type DevStatus, type GameRow, type GameType } from "@/lib/types";

export function GameActions({ game, pmEnabled }: { game: Pick<GameRow, "id" | "name" | "game_type" | "dev_status" | "pm_ref">; pmEnabled: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [saving, startSave] = useTransition();
  const [removing, startRemove] = useTransition();
  const editDlg = useRef<HTMLDialogElement>(null);
  const removeDlg = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(game.name);
  const [type, setType] = useState<GameType>(game.game_type);
  const [status, setStatus] = useState<DevStatus>(game.dev_status);
  const [pmRef, setPmRef] = useState(game.pm_ref ?? "");
  const [typed, setTyped] = useState("");

  const refresh = () => startRefresh(async () => {
    const r = await refreshGameAction(game.id);
    setMsg(r.ok ? { ok: true, text: "Refreshed from GitHub." } : { ok: false, text: r.error });
    router.refresh();
  });
  const save = () => startSave(async () => {
    const r = await updateGameAction({ id: game.id, name, type, devStatus: status, pmRef });
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    editDlg.current?.close();
    router.refresh();
  });
  const remove = () => startRemove(async () => {
    const r = await removeGameAction(game.id, typed);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    router.push("/games");
    router.refresh();
  });

  return (
    <>
      <button className="btn" onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      <button className="btn" onClick={() => editDlg.current?.showModal()}>Edit</button>
      <button className="btn btn-danger" onClick={() => { setTyped(""); removeDlg.current?.showModal(); }}>Remove</button>
      {msg && <p role="status" className={`w-full text-sm ${msg.ok ? "text-muted" : "text-[var(--bad-fg)]"}`}>{msg.text}</p>}

      <dialog ref={editDlg} className="m-auto w-[min(92vw,28rem)] rounded-xl border border-line bg-surface p-5 text-fg backdrop:bg-black/50">
        <h2 className="text-base font-semibold">Edit game</h2>
        <div className="mt-3 grid gap-3">
          <label className="text-sm font-medium">Name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
          <label className="text-sm font-medium">Type
            <select className="input mt-1" value={type} onChange={(e) => setType(e.target.value as GameType)}><option value="mini">Mini</option><option value="premium">Premium</option></select>
          </label>
          <label className="text-sm font-medium">Development status
            <select className="input mt-1" value={status} onChange={(e) => setStatus(e.target.value as DevStatus)}>{DEV_STATUSES.map((s) => <option key={s} value={s}>{DEV_STATUS_LABEL[s]}</option>)}</select>
          </label>
          <label className="text-sm font-medium">Master Game PM reference <span className="font-normal text-muted">(optional{pmEnabled ? "" : ", PM link not configured"})</span>
            <input className="input mt-1" value={pmRef} onChange={(e) => setPmRef(e.target.value)} maxLength={200} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn" onClick={() => editDlg.current?.close()}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </dialog>

      <dialog ref={removeDlg} className="m-auto w-[min(92vw,28rem)] rounded-xl border border-line bg-surface p-5 text-fg backdrop:bg-black/50">
        <h2 className="text-base font-semibold">Remove “{game.name}” from the portal?</h2>
        <p className="mt-2 text-sm text-muted">This deletes the portal record and its stored workflow status. The GitHub repository is not touched. You can reconnect it later.</p>
        <input className="input mt-3" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={game.name} aria-label="Type the game name to confirm" />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn" onClick={() => removeDlg.current?.close()}>Cancel</button>
          <button className="btn btn-danger" onClick={remove} disabled={removing || typed.trim() !== game.name}>{removing ? "Removing…" : "Remove game"}</button>
        </div>
      </dialog>
    </>
  );
}
