import { NextResponse, type NextRequest } from "next/server";
import { apiGuard, errorMessage } from "@/lib/api";
import { readAdMobEnv } from "@/lib/revenue/admob";
import { syncAdMob } from "@/lib/revenue/sync";

/** Refresh revenue from AdMob (last 30 days by default). */
export async function POST(request: NextRequest) {
  const g = await apiGuard(request);
  if ("error" in g) return g.error;
  const cfg = readAdMobEnv();
  if (!cfg.ok) return NextResponse.json({ ok: false, error: `AdMob is not configured (missing ${cfg.missing.join(", ")}).` }, { status: 400 });
  try {
    const body = (await request.json().catch(() => ({}))) as { days?: number };
    const result = await syncAdMob(g.supabase, cfg.env, Number.isFinite(body.days) ? Number(body.days) : 30);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorMessage(e) }, { status: 400 });
  }
}
