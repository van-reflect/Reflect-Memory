// In-process backup to S3-compatible storage. Called by the main server on a schedule.
// Requires RM_BACKUP_S3_* env vars. No-op if not configured.

import { createHash, createHmac } from "node:crypto";
import { statSync, unlinkSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

const DB_PATH = process.env.RM_DB_PATH || "/data/reflect-memory.db";
const S3_ENDPOINT = process.env.RM_BACKUP_S3_ENDPOINT;
const S3_BUCKET = process.env.RM_BACKUP_S3_BUCKET;
const S3_KEY_ID = process.env.RM_BACKUP_S3_KEY_ID;
const S3_KEY_SECRET = process.env.RM_BACKUP_S3_KEY_SECRET;
const S3_REGION = process.env.RM_BACKUP_S3_REGION || "auto";

export function isBackupConfigured(): boolean {
  return !!(S3_ENDPOINT && S3_BUCKET && S3_KEY_ID && S3_KEY_SECRET);
}

export async function runBackup(): Promise<void> {
  if (!isBackupConfigured()) {
    console.log("[backup] Skipped — RM_BACKUP_S3_* not configured");
    return;
  }

  const now = new Date();
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timestamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const backupFile = `/tmp/reflect-memory-backup-${timestamp}.db`;
  const objectKey = `backups/reflect-memory-${datestamp}-${timestamp}.db`;

  try {
    const source = new Database(DB_PATH, { readonly: true });
    await source.backup(backupFile);
    source.close();

    const size = statSync(backupFile).size;
    console.log(`[backup] Snapshot created: ${(size / 1024).toFixed(1)} KB`);

    await uploadToS3(backupFile, objectKey, datestamp, timestamp);
    unlinkSync(backupFile);
    console.log(`[backup] Complete. Uploaded to ${S3_BUCKET}/${objectKey}`);
  } catch (err) {
    console.error("[backup] Failed:", err);
    try {
      unlinkSync(backupFile);
    } catch {
      // ignore
    }
    throw err;
  }
}

async function uploadToS3(
  filePath: string,
  key: string,
  datestamp: string,
  timestamp: string,
): Promise<void> {
  const fileBuffer = readFileSync(filePath);
  const size = fileBuffer.length;
  const payloadHash = createHash("sha256").update(fileBuffer).digest("hex");

  const headers: Record<string, string> = {
    Host: new URL(S3_ENDPOINT!).host,
    "Content-Type": "application/octet-stream",
    "Content-Length": String(size),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };

  const signedHeaders = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
    .join(";");
  const canonicalHeaders =
    Object.entries(headers)
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
      .sort()
      .join("\n") + "\n";

  const canonicalRequest = [
    "PUT",
    `/${S3_BUCKET}/${key}`,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${datestamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signingKey = getSignatureKey(S3_KEY_SECRET!, datestamp, S3_REGION, "s3");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${S3_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: fileBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 upload failed (${res.status}): ${text}`);
  }
}

function getSignatureKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}
