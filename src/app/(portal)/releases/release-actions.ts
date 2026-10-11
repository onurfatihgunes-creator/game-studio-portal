"use server";

import { revalidatePath } from "next/cache";
import { createCandidate, decideRelease, type Decision } from "@/lib/releases";
import { requireUser } from "@/lib/supabase/server";
import type { ActionResult } from "../games/actions";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");
const UUID = /^[0-9a-f-]{36}$/i;

export async function createCandidateAction(input: { gameId: string; runId: string; platform: "android" | "ios" }): Promise<ActionResult<{ id: string }>> {
  try {
    const { supabase } = await requireUser();
    if (!UUID.test(input.gameId) || !UUID.test(input.runId) || (input.platform !== "android" && input.platform !== "ios")) throw new Error("Invalid request");
    const id = await createCandidate(supabase, input);
    revalidatePath("/", "layout");
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function decideReleaseAction(input: { releaseId: string; decision: Decision; typedName: string; notes?: string }): Promise<ActionResult> {
  try {
    const { supabase, user } = await requireUser();
    if (!UUID.test(input.releaseId) || !["approve", "reject", "published_manually"].includes(input.decision)) throw new Error("Invalid request");
    await decideRelease(supabase, input, { id: user.id, email: user.email ?? null });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
