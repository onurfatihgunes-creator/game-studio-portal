import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Google AdMob reporting (read-only). Scopes: admob.readonly + admob.report. Nothing here creates apps or ad units.
 * Endpoints/shapes verified against developers.google.com/admob/api/v1 (networkReport:generate is a stream of
 * header / row / footer messages; earnings are `microsValue`; the only supported report timezone is America/Los_Angeles).
 */
export const ADMOB_SCOPES = ["https://www.googleapis.com/auth/admob.readonly", "https://www.googleapis.com/auth/admob.report"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://admob.googleapis.com/v1";

export type AdMobEnv = { clientId: string; clientSecret: string; encryptionKey: string };
export function readAdMobEnv(): { ok: true; env: AdMobEnv } | { ok: false; missing: string[] } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const encryptionKey = process.env.ADMOB_TOKEN_ENCRYPTION_KEY?.trim();
  const missing = [!clientId && "GOOGLE_OAUTH_CLIENT_ID", !clientSecret && "GOOGLE_OAUTH_CLIENT_SECRET", !encryptionKey && "ADMOB_TOKEN_ENCRYPTION_KEY"].filter(Boolean) as string[];
  return missing.length || !clientId || !clientSecret || !encryptionKey ? { ok: false, missing } : { ok: true, env: { clientId, clientSecret, encryptionKey } };
}

// ── OAuth (authorization code + PKCE S256) ───────────────────────────────────
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: "code", scope: ADMOB_SCOPES.join(" "),
    access_type: "offline", prompt: "select_account consent", include_granted_scopes: "false", state: p.state,
    code_challenge: p.challenge, code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

type TokenResponse = { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
async function tokenCall(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) throw new AdMobError(`Google token endpoint: ${json.error ?? res.status}${json.error_description ? ` — ${json.error_description}` : ""}`, json.error === "invalid_grant" ? "reauthorize" : "failed");
  return json;
}
export class AdMobError extends Error {
  constructor(message: string, readonly kind: "reauthorize" | "failed" | "api_disabled" | "forbidden" = "failed") { super(message); this.name = "AdMobError"; }
}

export const exchangeCode = (env: AdMobEnv, code: string, redirectUri: string, verifier: string) =>
  tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: env.clientId, client_secret: env.clientSecret, code_verifier: verifier });
export async function refreshAccessToken(env: AdMobEnv, refreshToken: string): Promise<string> {
  const t = await tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.clientId, client_secret: env.clientSecret });
  if (!t.access_token) throw new AdMobError("Google returned no access token");
  return t.access_token;
}
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), cache: "no-store" }).catch(() => undefined);
}

// ── API calls ────────────────────────────────────────────────────────────────
async function api<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  // Identical to what Google's official client library sends for a GET: only Authorization (Content-Type only when there is a body).
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let detail = ""; let reason = ""; let rawBody = "";
    try {
      rawBody = (await res.text()).slice(0, 700); // Google's error bodies carry no credentials; kept for diagnosis
      const j = JSON.parse(rawBody) as { error?: { message?: string; details?: { reason?: string }[] } };
      detail = j.error?.message ?? ""; reason = j.error?.details?.find((d) => d.reason)?.reason ?? "";
    } catch { /* not JSON */ }
    // Google reports "API not enabled in the Cloud project" as 403 SERVICE_DISABLED / accessNotConfigured.
    const disabled = reason === "SERVICE_DISABLED" || reason === "ACCESS_NOT_CONFIGURED" || /has not been used in project|is disabled|accessNotConfigured/i.test(detail);
    const wa = res.headers.get("www-authenticate");
    throw new AdMobError(`AdMob API ${res.status}: ${detail || res.statusText}${reason ? ` [reason=${reason}]` : ""}${wa ? ` [www-authenticate=${wa.slice(0, 160)}]` : " [no www-authenticate header]"}${reason ? "" : ` [response-body=${rawBody.replace(/\s+/g, " ")}]`}`, res.status === 401 ? "reauthorize" : disabled ? "api_disabled" : res.status === 403 ? "forbidden" : "failed");
  }
  return (await res.json()) as T;
}

/**
 * Failure diagnostics only: asks Google's tokeninfo endpoint what an access token is (scopes, lifetime, audience).
 * Returns a short secret-free summary; the token itself is never returned or logged.
 */
export async function describeAccessToken(accessToken: string, clientId: string): Promise<string> {
  const shape = `length=${accessToken.length}, ya29-prefix=${accessToken.startsWith("ya29.")}`;
  try {
    const res = await fetch("https://oauth2.googleapis.com/tokeninfo", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: accessToken }), cache: "no-store" });
    const j = (await res.json()) as { error?: string; error_description?: string; scope?: string; expires_in?: string | number; aud?: string; azp?: string };
    if (!res.ok || j.error) return `${shape}; tokeninfo: ${j.error ?? res.status}${j.error_description ? ` (${j.error_description})` : ""}`;
    const scopes = (j.scope ?? "").split(" ").map((s) => s.split("/").pop()).join(",");
    return `${shape}; tokeninfo: scopes=[${scopes}] expires_in=${j.expires_in}s audience_matches_client=${(j.aud ?? j.azp) === clientId}`;
  } catch (e) {
    return `${shape}; tokeninfo unavailable: ${e instanceof Error ? e.message : "error"}`;
  }
}

export async function listPublisherIds(accessToken: string): Promise<string[]> {
  const r = await api<{ account?: { name?: string; publisherId?: string }[] }>(accessToken, "/accounts");
  return (r.account ?? []).map((a) => a.publisherId ?? a.name?.replace(/^accounts\//, "") ?? "").filter(Boolean);
}

export type ReportRange = { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } };

/** Dates in the report's timezone (America/Los_Angeles, the only one AdMob supports). */
export function laDate(d: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: g("year"), month: g("month"), day: g("day") };
}
export function lastDays(days: number, now = new Date()): ReportRange {
  const end = laDate(now);
  const start = laDate(new Date(now.getTime() - (days - 1) * 86_400_000));
  return { start, end };
}

export const reportBody = (range: ReportRange) => ({
  reportSpec: {
    dateRange: { startDate: range.start, endDate: range.end },
    dimensions: ["DATE", "APP"],
    metrics: ["ESTIMATED_EARNINGS", "IMPRESSIONS", "CLICKS"],
    timeZone: "America/Los_Angeles",
    maxReportRows: 100000,
  },
});

export type ReportRow = { day: string; appId: string; appName: string | null; earningsMicros: bigint; impressions: bigint; clicks: bigint };
export type ParsedReport = { currency: string | null; rows: ReportRow[]; truncated: boolean };

const asBig = (v: unknown): bigint => { try { return BigInt(String(v ?? "0")); } catch { return 0n; } };

/** Accepts the streamed response (array of header/row/footer messages) and returns normalized rows. Unknown shapes are ignored. */
export function parseNetworkReport(messages: unknown): ParsedReport {
  const list = Array.isArray(messages) ? messages : [];
  let currency: string | null = null; let matching: number | null = null; const rows: ReportRow[] = [];
  for (const m of list as Record<string, any>[]) {
    if (m?.header) currency = m.header.localizationSettings?.currencyCode ?? currency;
    if (m?.footer) matching = Number(m.footer.matchingRowCount ?? NaN);
    const r = m?.row;
    if (!r) continue;
    const date = String(r.dimensionValues?.DATE?.value ?? "");
    const appId = String(r.dimensionValues?.APP?.value ?? "");
    if (!/^\d{8}$/.test(date) || !appId) continue;
    const mv = r.metricValues ?? {};
    rows.push({
      day: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, appId, appName: r.dimensionValues?.APP?.displayLabel ?? null,
      earningsMicros: asBig(mv.ESTIMATED_EARNINGS?.microsValue), impressions: asBig(mv.IMPRESSIONS?.integerValue), clicks: asBig(mv.CLICKS?.integerValue),
    });
  }
  return { currency, rows, truncated: matching !== null && Number.isFinite(matching) && matching > rows.length };
}

export async function fetchNetworkReport(accessToken: string, publisherId: string, range: ReportRange): Promise<ParsedReport> {
  const pub = publisherId.startsWith("pub-") ? publisherId : `pub-${publisherId.replace(/^pub-/, "")}`;
  const raw = await api<unknown>(accessToken, `/accounts/${encodeURIComponent(pub)}/networkReport:generate`, { method: "POST", body: JSON.stringify(reportBody(range)) });
  return parseNetworkReport(raw);
}

// ── mapping AdMob apps → portal games ────────────────────────────────────────
export type GameApps = { gameId: string; appIds: string[] };
export type DailyRow = { game_id: string; day: string; currency: string; earnings_micros: string; impressions: string; clicks: string };

/** Sums rows of a game's Android + iOS apps per day. Rows of unknown apps are returned as `unmatched`, never guessed. */
export function mapRowsToGames(rows: ReportRow[], games: GameApps[], currency: string): { daily: DailyRow[]; unmatched: { appId: string; appName: string | null }[] } {
  const owner = new Map<string, string>();
  for (const g of games) for (const id of g.appIds) owner.set(id, g.gameId);
  const sums = new Map<string, DailyRow & { e: bigint; i: bigint; c: bigint }>();
  const unmatched = new Map<string, string | null>();
  for (const r of rows) {
    const gameId = owner.get(r.appId);
    if (!gameId) { unmatched.set(r.appId, r.appName); continue; }
    const k = `${gameId}|${r.day}`;
    const cur = sums.get(k) ?? { game_id: gameId, day: r.day, currency, earnings_micros: "0", impressions: "0", clicks: "0", e: 0n, i: 0n, c: 0n };
    cur.e += r.earningsMicros; cur.i += r.impressions; cur.c += r.clicks;
    sums.set(k, cur);
  }
  return {
    daily: [...sums.values()].map(({ e, i, c, ...row }) => ({ ...row, earnings_micros: e.toString(), impressions: i.toString(), clicks: c.toString() })),
    unmatched: [...unmatched].map(([appId, appName]) => ({ appId, appName })),
  };
}

/** eCPM = earnings per 1000 impressions; null when there are no impressions (never divides by zero or invents a value). */
export function ecpm(earningsMicros: number, impressions: number): number | null {
  return impressions > 0 ? earningsMicros / 1e6 / impressions * 1000 : null;
}
