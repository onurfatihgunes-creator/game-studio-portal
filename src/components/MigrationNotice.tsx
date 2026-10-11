import { MIGRATION_FILE } from "@/lib/phase2";

/** Shown instead of crashing when the Phase 02 tables are not in the database yet. */
export function MigrationNotice({ what }: { what: string }) {
  return (
    <p role="alert" className="mb-4 rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">
      <strong>Database update needed.</strong> {what} needs the Phase 02 tables. Open the Supabase SQL Editor, paste <code>{MIGRATION_FILE}</code> and press Run (safe to run more than once). Everything else keeps working.
    </p>
  );
}
