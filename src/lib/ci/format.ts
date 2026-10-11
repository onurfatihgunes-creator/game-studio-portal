export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export const fmtMB = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1)} MB`;
