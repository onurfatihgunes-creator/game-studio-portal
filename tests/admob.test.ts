import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { buildAuthUrl, challengeFor, ecpm, lastDays, laDate, mapRowsToGames, parseNetworkReport, pkcePair, reportBody, ADMOB_SCOPES } from "@/lib/revenue/admob";
import { syncAdMob } from "@/lib/revenue/sync";
import { memdb } from "./memdb";

const h = vi.hoisted(() => ({ user: { email: "dev@studio.test" } as { email: string } | null, upserts: [] as any[], upsertError: null as { message: string } | null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) }, from: () => ({ upsert: async (r: any) => (h.upserts.push(r), { error: h.upsertError }) }) }),
}));

const KEY = randomBytes(32).toString("base64");
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("secret encryption", () => {
  it("round-trips, uses a fresh IV, and rejects tampering and wrong keys", () => {
    const a = encryptSecret("1//refresh-token", KEY), b = encryptSecret("1//refresh-token", KEY);
    expect(a).not.toEqual(b);
    expect(a).not.toContain("refresh-token");
    expect(decryptSecret(a, KEY)).toBe("1//refresh-token");
    const parts = a.split("."); parts[3] = Buffer.from("x" + Buffer.from(parts[3], "base64url").toString("latin1")).toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow();
    expect(() => decryptSecret(a, randomBytes(32).toString("base64"))).toThrow();
    expect(() => encryptSecret("x", "short")).toThrow(/32 bytes/);
  });
});

describe("OAuth helpers", () => {
  it("PKCE challenge is base64url(sha256(verifier)) — RFC 7636 test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const p = pkcePair(); expect(challengeFor(p.verifier)).toBe(p.challenge); expect(p.verifier.length).toBeGreaterThanOrEqual(43);
  });
  it("auth URL requests offline access, both read-only scopes, PKCE S256 and state", () => {
    const u = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://localhost:3000/cb", state: "st", challenge: "ch" }));
    expect(u.host).toBe("accounts.google.com");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("select_account consent"); // always show the account chooser; the AdMob owner may not be the browser's default account
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(ADMOB_SCOPES);
    expect(ADMOB_SCOPES.every((s) => s.endsWith("admob.readonly") || s.endsWith("admob.report"))).toBe(true); // read-only, no monetization (write) scope
  });
});

describe("report handling", () => {
  const stream = [
    { header: { dateRange: {}, localizationSettings: { currencyCode: "EUR" } } },
    { row: { dimensionValues: { DATE: { value: "20261010" }, APP: { value: "ca-app-pub-1111222233334444~1234567890", displayLabel: "Example Runner" } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "6500000" }, IMPRESSIONS: { integerValue: "1000" }, CLICKS: { integerValue: "12" } } } },
    { row: { dimensionValues: { DATE: { value: "20261010" }, APP: { value: "ca-app-pub-1111222233334444~0987654321", displayLabel: "Example Runner iOS" } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "1500000" }, IMPRESSIONS: { integerValue: "250" }, CLICKS: { integerValue: "1" } } } },
    { row: { dimensionValues: { DATE: { value: "20261011" }, APP: { value: "ca-app-pub-1111222233334444~1234567890" } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "2000000" }, IMPRESSIONS: { integerValue: "300" } } } },
    { row: { dimensionValues: { DATE: { value: "20261011" }, APP: { value: "ca-app-pub-9999000011112222~1111111111", displayLabel: "Someone else" } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "999" }, IMPRESSIONS: { integerValue: "1" } } } },
    { row: { dimensionValues: { DATE: { value: "bad" }, APP: { value: "x" } }, metricValues: {} } },
    { footer: { matchingRowCount: "4" } },
  ];
  it("parses header/rows/footer, skips malformed rows, reads currency", () => {
    const r = parseNetworkReport(stream);
    expect(r.currency).toBe("EUR"); expect(r.rows).toHaveLength(4); expect(r.truncated).toBe(false);
    expect(r.rows[0]).toMatchObject({ day: "2026-10-10", earningsMicros: 6500000n, impressions: 1000n, clicks: 12n });
    expect(parseNetworkReport("garbage").rows).toEqual([]);
    expect(parseNetworkReport([...stream.slice(0, -1), { footer: { matchingRowCount: "9" } }]).truncated).toBe(true);
  });
  it("attributes Android+iOS apps of one game per day and reports unknown apps instead of guessing", () => {
    const r = parseNetworkReport(stream);
    const { daily, unmatched } = mapRowsToGames(r.rows, [{ gameId: "g1", appIds: ["ca-app-pub-1111222233334444~1234567890", "ca-app-pub-1111222233334444~0987654321"] }], "EUR");
    expect(daily.find((d) => d.day === "2026-10-10")).toMatchObject({ game_id: "g1", earnings_micros: "8000000", impressions: "1250", clicks: "13", currency: "EUR" });
    expect(daily.find((d) => d.day === "2026-10-11")).toMatchObject({ earnings_micros: "2000000", clicks: "0" });
    expect(unmatched).toEqual([{ appId: "ca-app-pub-9999000011112222~1111111111", appName: "Someone else" }]);
  });
  it("eCPM never divides by zero or invents a value", () => {
    expect(ecpm(8_000_000, 1250)).toBeCloseTo(6.4, 5);
    expect(ecpm(0, 0)).toBeNull();
  });
  it("builds the documented request body in the only supported timezone", () => {
    const b = reportBody(lastDays(30, new Date("2026-10-11T12:00:00Z"))).reportSpec;
    expect(b.timeZone).toBe("America/Los_Angeles"); expect(b.dimensions).toEqual(["DATE", "APP"]); expect(b.metrics).toContain("ESTIMATED_EARNINGS");
    expect(b.dateRange.endDate).toEqual(laDate(new Date("2026-10-11T12:00:00Z")));
    expect(b.dateRange.startDate).toEqual({ year: 2026, month: 9, day: 12 });
  });
});

describe("syncAdMob (fake Google + in-memory DB)", () => {
  const env = { clientId: "cid", clientSecret: "sec", encryptionKey: KEY };
  const setup = (opts: { reportStatus?: number } = {}) => {
    const db = memdb({
      admob_connection: [{ id: 1, publisher_id: "pub-1111222233334444", token_ciphertext: encryptSecret("refresh-1", KEY), last_error: "old" }],
      game_ads_config: [{ game_id: "g1", android: { app_id: "ca-app-pub-1111222233334444~1234567890" }, ios: { app_id: "ca-app-pub-1111222233334444~0987654321" } }, { game_id: "g2", android: {}, ios: {} }],
      revenue_daily: [],
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "acc" });
      if (url.includes("networkReport:generate")) {
        expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer acc");
        if (opts.reportStatus) return json({ error: { message: "nope" } }, opts.reportStatus);
        return json([{ header: { localizationSettings: { currencyCode: "USD" } } }, { row: { dimensionValues: { DATE: { value: "20261010" }, APP: { value: "ca-app-pub-1111222233334444~1234567890" } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: "5000000" }, IMPRESSIONS: { integerValue: "500" }, CLICKS: { integerValue: "5" } } } }, { footer: { matchingRowCount: "1" } }]);
      }
      return json({}, 404);
    }));
    return { db, calls };
  };
  it("stores attributed revenue and clears the previous error", async () => {
    const { db, calls } = setup();
    const r = await syncAdMob(db, env, 30);
    expect(r).toMatchObject({ rows: 1, gamesWithData: 1, currency: "USD", unmatched: [] });
    expect((await db.from("revenue_daily").select()).data).toEqual([expect.objectContaining({ game_id: "g1", day: "2026-10-10", earnings_micros: "5000000", impressions: "500" })]);
    const c = (await db.from("admob_connection").select().eq("id", 1).maybeSingle()).data;
    expect(c.last_error).toBeNull(); expect(c.last_synced_at).toBeTruthy();
    expect(calls.some((u) => u.includes("accounts/pub-1111222233334444/networkReport"))).toBe(true);
  });
  it("records failures on the connection without touching stored revenue", async () => {
    const { db } = setup({ reportStatus: 500 });
    await db.from("revenue_daily").insert({ game_id: "g1", day: "2026-10-01", earnings_micros: "1", impressions: "1", currency: "USD" });
    await expect(syncAdMob(db, env, 30)).rejects.toThrow(/AdMob API 500/);
    expect((await db.from("revenue_daily").select()).data).toHaveLength(1);
    expect((await db.from("admob_connection").select().eq("id", 1).maybeSingle()).data.last_error).toMatch(/AdMob API 500/);
  });
  it("asks the user to reconnect when Google rejects the token", async () => {
    const { db } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant", error_description: "revoked" }, 400)));
    await expect(syncAdMob(db, env, 30)).rejects.toThrow(/connect AdMob again/);
  });
  it("refuses to sync when not connected", async () => {
    await expect(syncAdMob(memdb({ admob_connection: [] }), env)).rejects.toThrow(/not connected/);
  });
});

describe("OAuth routes", () => {
  beforeAll(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid"; process.env.GOOGLE_OAUTH_CLIENT_SECRET = "sec"; process.env.ADMOB_TOKEN_ENCRYPTION_KEY = KEY;
  });
  it("connect: signed-out users go to /login; signed-in users get Google with a state cookie", async () => {
    const { GET } = await import("@/app/api/integrations/admob/connect/route");
    h.user = null;
    expect((await GET(new NextRequest("http://localhost:3000/api/integrations/admob/connect"))).headers.get("location")).toContain("/login");
    h.user = { email: "dev@studio.test" };
    const res = await GET(new NextRequest("http://localhost:3000/api/integrations/admob/connect"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/integrations/admob/callback");
    const cookie = res.cookies.get("admob_oauth")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.value.split(".")[0]).toBe(loc.searchParams.get("state"));
    expect(loc.searchParams.get("code_challenge")).toBe(challengeFor(cookie.value.split(".")[1]));
  });
  it("callback: rejects a missing or mismatched state and a denied consent without calling Google", async () => {
    const { GET } = await import("@/app/api/integrations/admob/callback/route");
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const mk = (qs: string, cookie?: string) => new NextRequest(`http://localhost:3000/api/integrations/admob/callback?${qs}`, { headers: cookie ? { cookie: `admob_oauth=${cookie}` } : {} });
    expect((await GET(mk("code=abc&state=s1"))).headers.get("location")).toContain("admob=state");
    expect((await GET(mk("code=abc&state=EVIL", "s1.verifier"))).headers.get("location")).toContain("admob=state");
    expect((await GET(mk("error=access_denied", "s1.verifier"))).headers.get("location")).toContain("admob=denied");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("callback: full success stores an encrypted token and the publisher id", async () => {
    h.user = { email: "dev@studio.test" }; h.upserts.length = 0;
    const { GET } = await import("@/app/api/integrations/admob/callback/route");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/token")) { const b = String(init!.body); return json(b.includes("authorization_code") ? { access_token: "a", refresh_token: "1//secret-refresh", scope: ADMOB_SCOPES.join(" ") } : { access_token: "a2" }); }
      if (url.endsWith("/accounts")) return json({ account: [{ name: "accounts/pub-1111222233334444", publisherId: "pub-1111222233334444" }] });
      return json({}, 404);
    }));
    const res = await GET(new NextRequest("http://localhost:3000/api/integrations/admob/callback?code=abc&state=s1", { headers: { cookie: "admob_oauth=s1.verifier123" } }));
    expect(res.headers.get("location")).toContain("admob=connected");
    expect(h.upserts[0]).toMatchObject({ id: 1, publisher_id: "pub-1111222233334444", connected_by_email: "dev@studio.test" });
    expect(h.upserts[0].token_ciphertext).not.toContain("secret-refresh");
    expect(decryptSecret(h.upserts[0].token_ciphertext, KEY)).toBe("1//secret-refresh");
  });
});

describe("OAuth callback reports the REAL failing stage (and never logs secrets)", () => {
  const SECRET_CODE = "4/0AVERYSECRETAUTHCODE", SECRET_REFRESH = "1//SECRETREFRESHTOKEN";
  const run = async (opts: { tokenResponse?: Record<string, unknown>; tokenStatus?: number; accounts?: { status: number; body: unknown } }) => {
    h.user = { email: "dev@studio.test" }; h.upserts.length = 0; h.upsertError = null;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid"; process.env.GOOGLE_OAUTH_CLIENT_SECRET = "sec"; process.env.ADMOB_TOKEN_ENCRYPTION_KEY = KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/token")) {
        const b = String(init!.body);
        if (b.includes("authorization_code")) return json(opts.tokenResponse ?? { access_token: "a", refresh_token: SECRET_REFRESH, scope: ADMOB_SCOPES.join(" ") }, opts.tokenStatus ?? 200);
        return json({ access_token: "a2" });
      }
      if (url.endsWith("/accounts")) return json(opts.accounts?.body ?? { account: [{ publisherId: "pub-1111222233334444" }] }, opts.accounts?.status ?? 200);
      return json({}, 404);
    }));
    const { GET } = await import("@/app/api/integrations/admob/callback/route");
    const res = await GET(new NextRequest(`http://localhost:3000/api/integrations/admob/callback?code=${SECRET_CODE}&state=s1`, { headers: { cookie: "admob_oauth=s1.verifier123" } }));
    const logs = warn.mock.calls.map((c) => c.join(" ")).join("\n"); warn.mockRestore();
    return { code: new URL(res.headers.get("location")!).searchParams.get("admob"), logs };
  };

  it("code exchange rejected → exchange", async () => {
    const r = await run({ tokenResponse: { error: "invalid_grant", error_description: "Bad Request" }, tokenStatus: 400 });
    expect(r.code).toBe("exchange"); expect(r.logs).toMatch(/code exchange.*invalid_grant/);
  });
  it("no refresh token → no_refresh; missing scope → scope", async () => {
    expect((await run({ tokenResponse: { access_token: "a", scope: ADMOB_SCOPES.join(" ") } })).code).toBe("no_refresh");
    const r = await run({ tokenResponse: { access_token: "a", refresh_token: SECRET_REFRESH, scope: ADMOB_SCOPES[0] } });
    expect(r.code).toBe("scope"); expect(r.logs).toMatch(/missing admob\.report/);
  });
  it("AdMob API not enabled in the Cloud project → api_disabled", async () => {
    const body = { error: { code: 403, message: "AdMob API has not been used in project 123456789012 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] } };
    const r = await run({ accounts: { status: 403, body } });
    expect(r.code).toBe("api_disabled"); expect(r.logs).toMatch(/AdMob accounts\.list.*has not been used/);
  });
  it("other 403 → forbidden; 500 → api_failed; no AdMob account → account", async () => {
    expect((await run({ accounts: { status: 403, body: { error: { message: "The caller does not have permission" } } } })).code).toBe("forbidden");
    expect((await run({ accounts: { status: 500, body: { error: { message: "backend" } } } })).code).toBe("api_failed");
    const r = await run({ accounts: { status: 200, body: {} } });
    expect(r.code).toBe("account"); expect(r.logs).toMatch(/no AdMob account/);
  });
  it("database save failure → storage; success → connected", async () => {
    h.upsertError = null;
    expect((await run({})).code).toBe("connected");
    const r = await (async () => { const ok = await run({}); return ok; })();
    expect(r.code).toBe("connected");
    // storage failure
    h.user = { email: "dev@studio.test" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.upsertError = { message: 'relation "admob_connection" does not exist' };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/token")) return json(String(init!.body).includes("authorization_code") ? { access_token: "a", refresh_token: SECRET_REFRESH, scope: ADMOB_SCOPES.join(" ") } : { access_token: "a2" });
      return json({ account: [{ publisherId: "pub-1" }] });
    }));
    const { GET } = await import("@/app/api/integrations/admob/callback/route");
    const res = await GET(new NextRequest(`http://localhost:3000/api/integrations/admob/callback?code=${SECRET_CODE}&state=s1`, { headers: { cookie: "admob_oauth=s1.verifier123" } }));
    expect(res.headers.get("location")).toContain("admob=storage");
    warn.mockRestore(); h.upsertError = null;
  });
  it("401 on accounts.list → api_unauthorized, and the log carries tokeninfo facts but never the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.user = { email: "dev@studio.test" };
    const ACCESS = "ya29.SECRETACCESSTOKENVALUE";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tokeninfo")) return json({ scope: ADMOB_SCOPES.join(" "), expires_in: "3599", aud: "cid" });
      if (url.includes("/token")) return json(String(init!.body).includes("authorization_code") ? { access_token: "x", refresh_token: SECRET_REFRESH, scope: ADMOB_SCOPES.join(" ") } : { access_token: ACCESS });
      if (url.endsWith("/accounts")) return new Response(JSON.stringify({ error: { message: "Request is missing required authentication credential.", details: [{ reason: "CREDENTIALS_MISSING" }] } }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="https://accounts.google.com/"' } });
      return json({}, 404);
    }));
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    const { GET } = await import("@/app/api/integrations/admob/callback/route");
    const res = await GET(new NextRequest(`http://localhost:3000/api/integrations/admob/callback?code=${SECRET_CODE}&state=s1`, { headers: { cookie: "admob_oauth=s1.verifier123" } }));
    const logs = warn.mock.calls.map((c) => c.join(" ")).join("\n"); warn.mockRestore();
    expect(res.headers.get("location")).toContain("admob=api_unauthorized");
    expect(logs).toMatch(/CREDENTIALS_MISSING/); expect(logs).toMatch(/www-authenticate=Bearer/);
    expect(logs).toMatch(/tokeninfo: scopes=\[admob\.readonly,admob\.report\] expires_in=3599s audience_matches_client=true/);
    expect(logs).not.toContain(ACCESS); expect(logs).not.toContain(SECRET_REFRESH); expect(logs).not.toContain(SECRET_CODE);
  });
  it("never writes the authorization code, tokens or secrets to the log", async () => {
    const outs: string[] = [];
    for (const o of [{ tokenResponse: { error: "invalid_grant" }, tokenStatus: 400 }, { accounts: { status: 403, body: { error: { message: "x", details: [{ reason: "SERVICE_DISABLED" }] } } } }]) outs.push((await run(o)).logs);
    for (const l of outs) { expect(l).not.toContain(SECRET_CODE); expect(l).not.toContain(SECRET_REFRESH); expect(l).not.toContain("sec"); expect(l).not.toContain(KEY); }
  });
});
