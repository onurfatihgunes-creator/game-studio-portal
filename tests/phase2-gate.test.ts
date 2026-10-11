import { describe, expect, it } from "vitest";
import { isMissingSchemaError, phase2Ready, schemaHint } from "@/lib/phase2";

describe("graceful handling of an un-applied migration", () => {
  it("recognises 'table/column missing' errors and nothing else", () => {
    expect(isMissingSchemaError({ code: "PGRST205", message: "Could not find the table 'public.build_runs' in the schema cache" })).toBe(true);
    expect(isMissingSchemaError({ code: "PGRST204", message: "Could not find the 'project_facts' column of 'games' in the schema cache" })).toBe(true);
    expect(isMissingSchemaError({ code: "42P01" })).toBe(true);
    expect(isMissingSchemaError({ code: "42501", message: "permission denied for table games" })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
  it("phase2Ready is false only when the tables are missing (a permission error still means they exist)", async () => {
    const db = (error: unknown) => ({ from: () => ({ select: () => ({ limit: async () => ({ error }) }) }) }) as never;
    expect(await phase2Ready(db({ code: "PGRST205", message: "schema cache" }))).toBe(false);
    expect(await phase2Ready(db(null))).toBe(true);
    expect(await phase2Ready(db({ code: "42501", message: "permission denied" }))).toBe(true);
  });
  it("turns schema write failures into an actionable instruction", () => {
    expect(schemaHint("Could not find the 'project_facts' column of 'games' in the schema cache")).toMatch(/Apply supabase\/migrations\/0002/);
    expect(schemaHint("duplicate key value")).toBe("duplicate key value");
  });
});
