"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { type AdsConfig, type AdsStatus, type PlatformIds, DEMO_APP_IDS, DEMO_UNITS, normalizeConfig, validateConfig } from "@/lib/ads/config";
import { Badge } from "@/components/ui";
import { saveAdsAction } from "./actions";

const STATUS: Record<AdsStatus, { tone: "muted" | "warn" | "bad" | "good"; text: string }> = {
  not_configured: { tone: "muted", text: "Not configured" }, disabled: { tone: "muted", text: "Disabled" }, test: { tone: "warn", text: "Test mode" },
  invalid: { tone: "bad", text: "Invalid" }, production_ready: { tone: "good", text: "Production IDs set" },
};

function Ids({ label, hint, value, onChange }: { label: string; hint: string | null; value: PlatformIds; onChange: (v: PlatformIds) => void }) {
  const f = (k: keyof PlatformIds, name: string, ph: string) => (
    <label className="text-sm font-medium">{name}
      <input className="input mt-1 font-mono text-xs" value={value[k] ?? ""} placeholder={ph} onChange={(e) => onChange({ ...value, [k]: e.target.value })} spellCheck={false} />
    </label>
  );
  return (
    <fieldset className="card p-4">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      {hint && <p className="mb-2 text-xs text-muted">Project bundle id: <code>{hint}</code></p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {f("app_id", "AdMob app ID", "ca-app-pub-…~…")}
        {f("rewarded", "Rewarded unit", "ca-app-pub-…/…")}
        {f("interstitial", "Interstitial unit", "ca-app-pub-…/…")}
        {f("banner", "Banner unit (optional)", "ca-app-pub-…/…")}
      </div>
    </fieldset>
  );
}

const Num = ({ label, value, onChange, max }: { label: string; value: number; onChange: (n: number) => void; max: number }) => (
  <label className="text-sm font-medium">{label}
    <input className="input mt-1" type="number" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </label>
);

export function AdsForm({ gameId, gameName, initial, saved, status, androidId, iosId }: { gameId: string; gameName: string; initial: AdsConfig; saved: boolean; status: AdsStatus; androidId: string | null; iosId: string | null }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<AdsConfig>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const problems = useMemo(() => validateConfig(normalizeConfig(cfg)), [cfg]);
  const errors = problems.filter((p) => p.level === "error");
  const set = <K extends keyof AdsConfig>(k: K, v: AdsConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const st = STATUS[status];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={st.tone}>{saved ? st.text : "Not configured"}</Badge>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Ads enabled</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.test_mode} onChange={(e) => set("test_mode", e.target.checked)} /> Test mode (Google demo ads, no revenue)</label>
        <button className="btn ml-auto text-xs" type="button" onClick={() => setCfg((c) => ({ ...c, android: { app_id: DEMO_APP_IDS.android, ...DEMO_UNITS.android }, ios: { app_id: DEMO_APP_IDS.ios, ...DEMO_UNITS.ios }, test_mode: true }))}>Fill with Google demo IDs</button>
      </div>
      {!cfg.test_mode && cfg.enabled && <p className="rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">Production mode: real ads will be requested. Use only IDs from your own AdMob account, and complete the privacy/consent requirements below first.</p>}

      <div className="grid gap-4 xl:grid-cols-2">
        <Ids label="Android" hint={androidId} value={cfg.android} onChange={(v) => set("android", v)} />
        <Ids label="iOS" hint={iosId} value={cfg.ios} onChange={(v) => set("ios", v)} />
      </div>

      <fieldset className="card p-4">
        <legend className="px-1 text-sm font-semibold">Frequency caps and banner</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Num label="Interstitial: min seconds between" value={cfg.caps.interstitial_min_interval_s} max={3600} onChange={(n) => set("caps", { ...cfg.caps, interstitial_min_interval_s: n })} />
          <Num label="Interstitial: max per session" value={cfg.caps.interstitial_max_per_session} max={100} onChange={(n) => set("caps", { ...cfg.caps, interstitial_max_per_session: n })} />
          <Num label="Interstitial: first delay (s)" value={cfg.caps.interstitial_first_delay_s} max={3600} onChange={(n) => set("caps", { ...cfg.caps, interstitial_first_delay_s: n })} />
          <Num label="Interstitial: runs before the first" value={cfg.caps.interstitial_min_runs_before_first} max={50} onChange={(n) => set("caps", { ...cfg.caps, interstitial_min_runs_before_first: n })} />
          <Num label="Interstitial: at most once per N runs" value={cfg.caps.interstitial_every_n_runs} max={50} onChange={(n) => set("caps", { ...cfg.caps, interstitial_every_n_runs: n })} />
          <Num label="Rewarded: cooldown (s)" value={cfg.caps.rewarded_cooldown_s} max={3600} onChange={(n) => set("caps", { ...cfg.caps, rewarded_cooldown_s: n })} />
          <label className="text-sm font-medium">Banner
            <span className="mt-1 flex items-center gap-2"><input type="checkbox" checked={cfg.banner_enabled} onChange={(e) => set("banner_enabled", e.target.checked)} /> enabled
              <select className="input w-auto" value={cfg.banner_position} onChange={(e) => set("banner_position", e.target.value as "top" | "bottom")} aria-label="Banner position"><option value="bottom">bottom</option><option value="top">top</option></select></span>
          </label>
        </div>
      </fieldset>

      <fieldset className="card p-4">
        <legend className="px-1 text-sm font-semibold">Privacy and consent</legend>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.consent.tag_child_directed} onChange={(e) => set("consent", { ...cfg.consent, tag_child_directed: e.target.checked })} /> Child-directed treatment (COPPA)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.consent.tag_under_age_of_consent} onChange={(e) => set("consent", { ...cfg.consent, tag_under_age_of_consent: e.target.checked })} /> Under age of consent (GDPR)</label>
          <label className="flex items-center gap-2">Max content rating
            <select className="input w-auto" value={cfg.consent.max_ad_content_rating} onChange={(e) => set("consent", { ...cfg.consent, max_ad_content_rating: e.target.value as AdsConfig["consent"]["max_ad_content_rating"] })}>
              <option value="">default</option><option value="G">G</option><option value="PG">PG</option><option value="T">T</option><option value="MA">MA</option>
            </select></label>
        </div>
        <p className="mt-3 text-xs text-muted">Requirements the portal cannot do for you: configure a GDPR/UMP consent message in AdMob (Privacy &amp; messaging), publish a privacy policy, answer the Data safety / App Privacy forms truthfully, and on iOS add the ATT usage string and call the ATT prompt. The Unity module requests UMP consent before any ad request and never loads ads without it.</p>
      </fieldset>

      <label className="text-sm font-medium">Notes (optional)
        <textarea className="input mt-1" rows={2} maxLength={500} value={cfg.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
      </label>

      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" role="list">
          {problems.map((p, i) => <li key={i} className={p.level === "error" ? "text-[var(--bad-fg)]" : "text-[var(--warn-fg)]"}>{p.level === "error" ? "✕" : "!"} {p.message}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={pending || errors.length > 0} onClick={() => start(async () => {
          const res = await saveAdsAction(gameId, normalizeConfig(cfg));
          setMsg(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
          if (res.ok) router.refresh();
        })}>{pending ? "Saving…" : "Save"}</button>
        {saved && errors.length === 0 && <a className="btn" href={`/api/ads/${gameId}/export`}>Download StudioAdsConfig.json</a>}
        {msg && <span role="status" className={`text-sm ${msg.ok ? "text-muted" : "text-[var(--bad-fg)]"}`}>{msg.text}</span>}
        <span className="ml-auto text-xs text-muted">Place the file at <code>Assets/Resources/StudioAdsConfig.json</code> in {gameName}.</span>
      </div>
    </div>
  );
}
