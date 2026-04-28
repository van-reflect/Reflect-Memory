/**
 * LLM provider key encryption.
 *
 * Stores customer-supplied LLM API keys (Anthropic, etc.) encrypted at rest.
 * Risk model: keys are valuable but their abuse is bounded to financial loss
 * for the customer's LLM provider account, not data exfiltration. We aim for
 * "credibly secure," not "vault-grade."
 *
 * Scheme:
 *   - Master key from env `RM_LLM_KEY_ENCRYPTION_KEY` (64 hex chars = 32 bytes).
 *   - Per-tenant sub-key derived via HKDF-SHA256(masterKey, salt=scopeId, info)
 *     so a leaked encrypted blob alone is useless without knowing the team_id
 *     or user_id; rotation per tenant becomes trivial.
 *   - AES-256-GCM with a random 12-byte nonce per write.
 *   - Storage: `key_encrypted` BLOB = ciphertext || authTag (16-byte tag at
 *     the end); `key_nonce` BLOB = the 12-byte nonce; `key_last4` TEXT for UI.
 *
 * The master key is validated lazily on the first encrypt/decrypt call so
 * the API can boot without it (only fails when a key feature is exercised).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const MASTER_KEY_ENV = "RM_LLM_KEY_ENCRYPTION_KEY";
const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_BYTES = 32;
const HKDF_INFO = Buffer.from("reflect-memory:llm-key-v1");

let cachedMasterKey: Buffer | null = null;
let cachedMasterKeyError: Error | null = null;

function loadMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  if (cachedMasterKeyError) throw cachedMasterKeyError;

  const raw = process.env[MASTER_KEY_ENV];
  if (!raw || raw.trim().length === 0) {
    cachedMasterKeyError = new Error(
      `${MASTER_KEY_ENV} is not set. ` +
        `Generate one with \`openssl rand -hex 32\` and add it to your .env.`,
    );
    throw cachedMasterKeyError;
  }

  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    cachedMasterKeyError = new Error(
      `${MASTER_KEY_ENV} must be exactly 64 hex characters (32 bytes). ` +
        `Got ${trimmed.length} characters.`,
    );
    throw cachedMasterKeyError;
  }

  cachedMasterKey = Buffer.from(trimmed, "hex");
  return cachedMasterKey;
}

/**
 * Forces the master key to be loaded and validated. Call once at boot if you
 * want eager validation (fail-fast), or skip and let lazy validation kick in
 * the first time anyone tries to encrypt/decrypt a key.
 *
 * Returns true if the key is loaded successfully, false otherwise (and logs
 * a warning). Never throws so the API can boot in environments where LLM
 * features are unused.
 */
export function tryValidateMasterKey(): boolean {
  try {
    loadMasterKey();
    return true;
  } catch (err) {
    console.warn(
      `[llm-key-crypto] ${MASTER_KEY_ENV} not configured: ${err instanceof Error ? err.message : err}. ` +
        `LLM key features will be unavailable until this is set.`,
    );
    return false;
  }
}

/**
 * Resets cached master-key state. Test-only helper; do not call from prod code.
 */
export function _resetMasterKeyCacheForTests(): void {
  cachedMasterKey = null;
  cachedMasterKeyError = null;
}

export interface KeyScope {
  /** Exactly one of teamId or userId must be set (matches the llm_keys CHECK constraint). */
  teamId?: string | null;
  userId?: string | null;
}

function scopeId(scope: KeyScope): string {
  if (scope.teamId && scope.userId) {
    throw new Error("KeyScope must have exactly one of teamId or userId, not both");
  }
  if (scope.teamId) return `team:${scope.teamId}`;
  if (scope.userId) return `user:${scope.userId}`;
  throw new Error("KeyScope must have one of teamId or userId");
}

function deriveSubKey(scope: KeyScope): Buffer {
  const master = loadMasterKey();
  const salt = Buffer.from(scopeId(scope), "utf8");
  const derived = hkdfSync("sha256", master, salt, HKDF_INFO, SUBKEY_BYTES);
  return Buffer.from(derived);
}

export interface EncryptedKey {
  /** Ciphertext concatenated with the GCM auth tag (tag is the last 16 bytes). */
  ciphertext: Buffer;
  /** 12-byte GCM nonce. Random per encrypt call. */
  nonce: Buffer;
  /** Cleartext, for UI display only. Never includes the full key. */
  last4: string;
}

/**
 * Extracts the last 4 characters of the key for UI display. Strips trailing
 * whitespace defensively.
 */
export function extractLast4(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(-4);
}

/**
 * Encrypts a plaintext LLM key for the given scope. Returns the ciphertext+tag,
 * nonce, and last4 ready to persist.
 */
export function encryptLlmKey(plaintext: string, scope: KeyScope): EncryptedKey {
  if (!plaintext || plaintext.trim().length === 0) {
    throw new Error("Cannot encrypt empty LLM key");
  }
  const subKey = deriveSubKey(scope);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, subKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext.trim(), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length} (expected ${TAG_BYTES})`);
  }
  return {
    ciphertext: Buffer.concat([ciphertext, tag]),
    nonce,
    last4: extractLast4(plaintext),
  };
}

/**
 * Decrypts an LLM key for the given scope. Throws if the scope doesn't match
 * the one used to encrypt (HKDF derives a different sub-key) or if the
 * ciphertext was tampered with (GCM auth tag mismatch).
 */
export function decryptLlmKey(
  encrypted: { ciphertext: Buffer; nonce: Buffer },
  scope: KeyScope,
): string {
  if (encrypted.nonce.length !== NONCE_BYTES) {
    throw new Error(`Invalid nonce length: ${encrypted.nonce.length} (expected ${NONCE_BYTES})`);
  }
  if (encrypted.ciphertext.length < TAG_BYTES) {
    throw new Error(
      `Ciphertext too short to contain auth tag: ${encrypted.ciphertext.length} bytes`,
    );
  }
  const subKey = deriveSubKey(scope);
  const ciphertext = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - TAG_BYTES);
  const tag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, subKey, encrypted.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
