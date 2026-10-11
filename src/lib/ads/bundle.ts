import "server-only";
import { gunzipSync } from "fflate";
import { githubFetch, explain } from "@/lib/github/app";

/**
 * The shared Unity module, read from the studio's private `unity-ci` repository at a pinned ref (a tag), so every game gets the
 * same reviewed version and the module source never has to be copied into this (public) repository.
 */
export type BundleFile = { path: string; content: string };
export type ModuleBundle = {
  version: string;
  ref: string;
  /** Packages/com.studio.ads/** (module + tests + changelog), repo-relative to the Unity project root */
  module: BundleFile[];
  /** Assets/StudioAds/** (the Google Mobile Ads adapter + editor App-ID sync) */
  adapter: BundleFile[];
  /** Assets/StudioAds.meta */
  folderMeta: string | null;
};

/** Server env (not in the code, because the module repository is private): ADS_MODULE_REPO=owner/repo, ADS_MODULE_REF=tag (for example ads-v0.4.0). */
const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set. It names the private repository / tag that holds the shared ads module (see .env.example).`);
  return v;
};
export const MODULE_REPO = () => need("ADS_MODULE_REPO");
export const MODULE_REF = () => need("ADS_MODULE_REF");
const PKG = "Packages/com.studio.ads/";
const LIMITS = { files: 400, bytes: 4_000_000 };

/** Minimal ustar/pax tar reader (regular files only). GitHub's tarballs come from `git archive`. */
export function readTar(tar: Uint8Array): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = [];
  const text = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0.*$/s, "");
  let longName: string | null = null;
  let paxPath: string | null = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = text(h.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : "") + text(h.subarray(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = text(body); continue; }
    if (type === "x") {
      for (const line of new TextDecoder().decode(body).split("\n")) {
        const m = line.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "g") continue;
    const path = paxPath ?? longName ?? name;
    longName = paxPath = null;
    if (type === "0" || type === "\0") out.push({ path, data: body });
  }
  return out;
}

function safe(rel: string): boolean {
  return !!rel && !rel.startsWith("/") && !rel.split("/").some((p) => p === ".." || p === "");
}

/** Pure: turn the repository's files (paths relative to the repo root) into the bundle. */
export function buildBundle(files: BundleFile[], ref: string): ModuleBundle {
  if (files.length > LIMITS.files) throw new Error(`The ads module has ${files.length} files (limit ${LIMITS.files}); refusing.`);
  const get = (p: string) => files.find((f) => f.path === p)?.content ?? null;
  const pkgJson = get(`${PKG}package.json`);
  if (!pkgJson) throw new Error(`${PKG}package.json not found at ${ref}.`);
  const version = (JSON.parse(pkgJson) as { version?: string }).version;
  if (!version) throw new Error("The ads module has no version.");
  const module = files.filter((f) => f.path.startsWith(PKG) && safe(f.path));
  const SAMPLE = `${PKG}Samples~/GoogleMobileAds/`;
  const adapter = files.filter((f) => f.path.startsWith(SAMPLE) && safe(f.path)).map((f) => ({ path: `Assets/StudioAds/${f.path.slice(SAMPLE.length)}`, content: f.content }));
  return { version, ref, module, adapter, folderMeta: get(`${PKG}Templates~/StudioAds.folder.meta`) };
}

let cache: { key: string; at: number; bundle: ModuleBundle } | null = null;

/** Downloads the module once per ref (10 min in-memory cache). One API call (tarball). */
export async function loadModuleBundle(token: string, opts: { repo?: string; ref?: string } = {}): Promise<ModuleBundle> {
  const repo = opts.repo ?? MODULE_REPO();
  const ref = opts.ref ?? MODULE_REF();
  const key = `${repo}@${ref}`;
  if (cache && cache.key === key && Date.now() - cache.at < 10 * 60_000) return cache.bundle;
  const path = `/repos/${repo}/tarball/${encodeURIComponent(ref)}`;
  const res = await githubFetch(token, path);
  if (!res.ok) throw await explain(res, path);
  const tar = gunzipSync(new Uint8Array(await res.arrayBuffer()));
  const entries = readTar(tar);
  let bytes = 0;
  const files: BundleFile[] = [];
  for (const e of entries) {
    const rel = e.path.split("/").slice(1).join("/"); // drop the "owner-repo-sha/" root
    if (!rel.startsWith(PKG)) continue;
    bytes += e.data.length;
    if (bytes > LIMITS.bytes) throw new Error("The ads module is larger than expected; refusing.");
    files.push({ path: rel, content: new TextDecoder().decode(e.data) });
  }
  const bundle = buildBundle(files, ref);
  cache = { key, at: Date.now(), bundle };
  return bundle;
}

export function clearBundleCache() { cache = null; }
