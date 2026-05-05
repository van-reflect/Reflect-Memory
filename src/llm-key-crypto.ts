/**
 * Symmetric encryption for sensitive operational secrets — LLM provider keys,
 * Slack bot tokens, and any future per-tenant credential we need to round-trip
 * through SQLite.
 *
 * Risk model: secrets are valuable but their abuse is bounded (financial loss
 * for the customer's LLM provider account; access to a single Slack workspace
 * for the bot token). We aim for "credibly secure," not "vault-grade."
 *
 * Scheme:
 *   - Master key from env `RM_LLM_KEY_ENCRYPTION_KEY` (64 hex chars = 32 bytes).
 *     Single env var covers all uses; sub-keys are namespaced by salt.
 *   - Per-tenant sub-key derived via HKDF-SHA256(masterKey, salt=saltString,
 *     info) so a leaked encrypted blob alone is useless without knowing the
 *     tenant identifier; rotation per tenant becomes trivial.
 *   - AES-256-GCM with a random 12-byte nonce per write.
 *   - Storage: `ciphertext` BLOB = encrypted payload || authTag (16-byte tag
 *     at the end); `nonce` BLOB = the 12-byte nonce.
 *
 * The master key is validated lazily on the first encrypt/decrypt call so
 * the API can boot without it (only fails when a feature that needs it is
 * exercised). Domain wrappers like the LLM key service and the Slack
 * workspace service build their own salt strings, e.g. `team:<uuid>` or
 * `slack:<slack_team_id>`, and call encryptString / decryptString.
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

function deriveSubKey(saltString: string): Buffer {
  if (!saltString || saltString.trim().length === 0) {
    throw new Error("Salt string is required for key derivation");
  }
  const master = loadMasterKey();
  const salt = Buffer.from(saltString, "utf8");
  const derived = hkdfSync("sha256", master, salt, HKDF_INFO, SUBKEY_BYTES);
  return Buffer.from(derived);
}

export interface EncryptedBlob {
  /** Ciphertext concatenated with the GCM auth tag (tag is the last 16 bytes). */
  ciphertext: Buffer;
  /** 12-byte GCM nonce. Random per encrypt call. */
  nonce: Buffer;
}

/**
 * Extracts the last 4 characters of a string for UI display. Strips trailing
 * whitespace defensively.
 */
export function extractLast4(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return "";
  return trimmed.slice(-4);
}

/**
 * Generic primitive: encrypts a plaintext string with a sub-key derived from
 * the given salt. Domain wrappers (LLM keys, Slack tokens) build their own
 * salt strings, e.g. `team:<uuid>` or `slack:<slack_team_id>`.
 */
export function encryptString(plaintext: string, saltString: string): EncryptedBlob {
  if (!plaintext || plaintext.trim().length === 0) {
    throw new Error("Cannot encrypt empty string");
  }
  const subKey = deriveSubKey(saltString);
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
  };
}

/**
 * Generic primitive: decrypts a string previously encrypted with encryptString
 * using the same salt. Throws if the salt doesn't match (HKDF derives a
 * different sub-key) or if the ciphertext was tampered with (GCM auth tag).
 */
export function decryptString(
  encrypted: { ciphertext: Buffer; nonce: Buffer },
  saltString: string,
): string {
  if (encrypted.nonce.length !== NONCE_BYTES) {
    throw new Error(`Invalid nonce length: ${encrypted.nonce.length} (expected ${NONCE_BYTES})`);
  }
  if (encrypted.ciphertext.length < TAG_BYTES) {
    throw new Error(
      `Ciphertext too short to contain auth tag: ${encrypted.ciphertext.length} bytes`,
    );
  }
  const subKey = deriveSubKey(saltString);
  const ciphertext = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - TAG_BYTES);
  const tag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, subKey, encrypted.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// LLM key domain wrappers
// ---------------------------------------------------------------------------

export interface KeyScope {
  /** Exactly one of orgId or userId must be set (matches the llm_keys CHECK constraint). */
  orgId?: string | null;
  userId?: string | null;
}

function llmKeySalt(scope: KeyScope): string {
  if (scope.orgId && scope.userId) {
    throw new Error("KeyScope must have exactly one of orgId or userId, not both");
  }
  if (scope.orgId) return `team:${scope.orgId}`;
  if (scope.userId) return `user:${scope.userId}`;
  throw new Error("KeyScope must have one of orgId or userId");
}

export interface EncryptedKey extends EncryptedBlob {
  /** Cleartext, for UI display only. Never includes the full key. */
  last4: string;
}

/**
 * Encrypts a plaintext LLM key for the given scope. Returns the ciphertext+tag,
 * nonce, and last4 ready to persist.
 */
export function encryptLlmKey(plaintext: string, scope: KeyScope): EncryptedKey {
  const blob = encryptString(plaintext, llmKeySalt(scope));
  return { ...blob, last4: extractLast4(plaintext) };
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
  return decryptString(encrypted, llmKeySalt(scope));
}

// ---------------------------------------------------------------------------
// Slack bot token domain wrappers
// ---------------------------------------------------------------------------

/**
 * Encrypts a Slack bot token (xoxb-...) for the given Slack team. The Slack
 * team ID is used as the HKDF salt so each workspace's bot token is encrypted
 * under a different sub-key.
 */
export function encryptSlackBotToken(plaintext: string, slackTeamId: string): EncryptedBlob {
  if (!slackTeamId || slackTeamId.trim().length === 0) {
    throw new Error("slackTeamId is required for Slack bot token encryption");
  }
  return encryptString(plaintext, `slack:${slackTeamId}`);
}

/**
 * Decrypts a Slack bot token previously encrypted with encryptSlackBotToken.
 */
export function decryptSlackBotToken(
  encrypted: { ciphertext: Buffer; nonce: Buffer },
  slackTeamId: string,
): string {
  if (!slackTeamId || slackTeamId.trim().length === 0) {
    throw new Error("slackTeamId is required for Slack bot token decryption");
  }
  return decryptString(encrypted, `slack:${slackTeamId}`);
}
