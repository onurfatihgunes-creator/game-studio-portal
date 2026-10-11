/** Shown instead of crashing when a database migration has not been applied yet. */
export function MigrationNotice({ what, file }: { what: string; file: string }) {
  return (
    <p role="alert" className="mb-4 rounded-lg bg-[var(--warn-bg)] p-3 text-sm text-[var(--warn-fg)]">
      <strong>Database update needed.</strong> {what} needs a table that is not in the database yet. Open the Supabase SQL Editor, paste <code>{file}</code> and press Run (safe to run more than once). Everything else keeps working.
    </p>
  );
}
