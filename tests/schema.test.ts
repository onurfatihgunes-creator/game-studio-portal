import { describe, expect, it } from "vitest";
import { isMissingSchemaError, schemaState, tableExists } from "@/lib/schema";

/** Fake client that mimics supabase-js: a GET on a missing table errors with PGRST205. */
const fakeDb = (existing: string[]) => ({
  from: (t: string) => ({ select: () => ({ limit: async () => (existing.includes(t) ? { data: [], error: null } : { data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } }) }) }),
}) as never;

describe("schema detection", () => {
  it("recognises missing-table errors", () => {
    expect(isMissingSchemaError({ code: "PGRST205" })).toBe(true);
    expect(isMissingSchemaError({ message: "Could not find the table 'x' in the schema cache" })).toBe(true);
    expect(isMissingSchemaError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
  it("reports which migrations are applied", async () => {
    expect(await tableExists(fakeDb(["ads_policy"]), "ads_policy")).toBe(true);
    expect(await schemaState(fakeDb(["game_ads_config"]))).toEqual({ ads: true, apply: false });
    expect(await schemaState(fakeDb(["game_ads_config", "ads_policy"]))).toEqual({ ads: true, apply: true });
    expect(await schemaState(fakeDb([]))).toEqual({ ads: false, apply: false });
  });
});
