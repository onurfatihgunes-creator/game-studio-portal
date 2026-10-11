import { unzipSync } from "fflate";
import { isCiAction, type CiAction } from "./actions";

/**
 * portal-result.json — written by the shared workflows, uploaded as an artifact named `portal-result*`.
 * The file comes from a repository's workflow, so it is UNTRUSTED data: strict validation, hard size caps,
 * and the UI escapes everything. Anything that doesn't validate is dropped (never "repaired" or guessed).
 */
export type PortalResult = {
  schema: 1;
  action: CiAction;
  sha?: string;
  branch?: string;
  unityVersion?: string;
  bundleId?: string;
  version?: string;
  buildNumber?: number;
  durationS?: number;
  tests?: { mode: string; total: number; passed: number; failed: number; skipped: number; failures: { name: string; message: string }[] };
  errorSummary?: string;
  artifacts?: { name: string; bytes?: number; sha256?: string }[];
  notes?: string[];
};

export const MAX_RESULT_BYTES = 64 * 1024;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e12 ? Math.floor(v) : undefined);
const SHA = /^[0-9a-f]{7,64}$/i;

export function parsePortalResult(input: unknown): PortalResult | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (r.schema !== 1 || !isCiAction(r.action)) return null;

  const out: PortalResult = { schema: 1, action: r.action };
  if (typeof r.sha === "string" && SHA.test(r.sha)) out.sha = r.sha.toLowerCase();
  out.branch = str(r.branch, 200);
  out.unityVersion = str(r.unityVersion, 40);
  out.bundleId = str(r.bundleId, 200);
  out.version = str(r.version, 60);
  out.buildNumber = num(r.buildNumber);
  out.durationS = num(r.durationS);
  out.errorSummary = str(r.errorSummary, 2000);

  const t = r.tests as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    const total = num(t.total), passed = num(t.passed), failed = num(t.failed), skipped = num(t.skipped);
    if (total !== undefined && passed !== undefined && failed !== undefined && skipped !== undefined) {
      const failures = (Array.isArray(t.failures) ? t.failures : []).slice(0, 50).flatMap((f) => {
        const o = f as Record<string, unknown>;
        const name = str(o?.name, 300);
        return name ? [{ name, message: str(o.message, 500) ?? "" }] : [];
      });
      out.tests = { mode: str(t.mode, 20) ?? "unknown", total, passed, failed, skipped, failures };
    }
  }
  if (Array.isArray(r.artifacts)) {
    out.artifacts = r.artifacts.slice(0, 20).flatMap((a) => {
      const o = a as Record<string, unknown>;
      const name = str(o?.name, 200);
      if (!name) return [];
      const sha = typeof o.sha256 === "string" && /^[0-9a-f]{64}$/i.test(o.sha256) ? o.sha256.toLowerCase() : undefined;
      return [{ name, bytes: num(o.bytes), sha256: sha }];
    });
  }
  if (Array.isArray(r.notes)) out.notes = r.notes.slice(0, 10).flatMap((n) => (str(n, 300) ? [str(n, 300) as string] : []));
  return out;
}

/** Extracts and validates the JSON from a `portal-result` artifact zip. Null on any problem. */
export function readPortalResultZip(zip: Uint8Array): PortalResult | null {
  try {
    if (zip.byteLength > 1024 * 1024) return null;
    const files = unzipSync(zip, { filter: (f) => f.originalSize <= MAX_RESULT_BYTES });
    const entry = files["portal-result.json"] ?? Object.values(files)[0];
    if (!entry || entry.byteLength > MAX_RESULT_BYTES) return null;
    return parsePortalResult(JSON.parse(new TextDecoder().decode(entry)));
  } catch {
    return null;
  }
}
