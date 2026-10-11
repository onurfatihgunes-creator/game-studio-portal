import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets stored in Supabase (the AdMob refresh token). The key lives ONLY in server env
 * (ADMOB_TOKEN_ENCRYPTION_KEY, 32 random bytes, base64), so database readers get useless ciphertext.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
function key(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("ADMOB_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
  return k;
}

export function encryptSecret(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(keyB64), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, keyB64: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext format");
  const d = createDecipheriv("aes-256-gcm", key(keyB64), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
