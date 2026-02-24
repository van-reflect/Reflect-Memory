// Automated SQLite backup to S3-compatible storage (Cloudflare R2, AWS S3, etc.)
// Runs as a standalone script: npx tsx scripts/backup-db.ts
// Uses SQLite's .backup API for a consistent snapshot (safe during writes).
//
// Required env vars:
//   RM_DB_PATH              — SQLite database path (default: /data/reflect-memory.db)
//   RM_BACKUP_S3_ENDPOINT   — S3 endpoint (e.g. https://<account>.r2.cloudflarestorage.com)
//   RM_BACKUP_S3_BUCKET     — Bucket name
//   RM_BACKUP_S3_KEY_ID     — Access key ID
//   RM_BACKUP_S3_KEY_SECRET — Secret access key
//   RM_BACKUP_S3_REGION     — Region (default: auto)

import { createReadStream, statSync, unlinkSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import Database from "better-sqlite3";

const DB_PATH = process.env.RM_DB_PATH || "/data/reflect-memory.db";
const S3_ENDPOINT = process.env.RM_BACKUP_S3_ENDPOINT;
const S3_BUCKET = process.env.RM_BACKUP_S3_BUCKET;
const S3_KEY_ID = process.env.RM_BACKUP_S3_KEY_ID;
const S3_KEY_SECRET = process.env.RM_BACKUP_S3_KEY_SECRET;
const S3_REGION = process.env.RM_BACKUP_S3_REGION || "auto";

if (!S3_ENDPOINT || !S3_BUCKET || !S3_KEY_ID || !S3_KEY_SECRET) {
  console.error("Missing required RM_BACKUP_S3_* environment variables.");
  process.exit(1);
}

const now = new Date();
const datestamp = now.toISOString().slice(0, 10).replace(/-/g, "");
const timestamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
const backupFile = `/tmp/reflect-memory-backup-${timestamp}.db`;
const objectKey = `backups/reflect-memory-${datestamp}-${timestamp}.db`;

// 1. Create a consistent backup using SQLite's backup API
console.log(`[backup] Opening database: ${DB_PATH}`);
const source = new Database(DB_PATH, { readonly: true });
source.backup(backupFile).then(() => {
  source.close();
  const size = statSync(backupFile).size;
  console.log(`[backup] Snapshot created: ${backupFile} (${(size / 1024).toFixed(1)} KB)`);
  return uploadToS3(backupFile, objectKey);
}).then(() => {
  unlinkSync(backupFile);
  console.log(`[backup] Complete. Uploaded to ${S3_BUCKET}/${objectKey}`);
  process.exit(0);
}).catch((err) => {
  console.error(`[backup] Failed:`, err);
  try { unlinkSync(backupFile); } catch {}
  process.exit(1);
});

// 2. Upload to S3-compatible storage using raw HTTP (no SDK dependency)
async function uploadToS3(filePath: string, key: string): Promise<void> {
  const body = createReadStream(filePath);
  const { size } = statSync(filePath);

  const fileBuffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

  const host = new URL(S3_ENDPOINT!).host;
  const url = `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
  const payloadHash = createHash("sha256").update(fileBuffer).digest("hex");

  const headers: Record<string, string> = {
    "Host": host,
    "Content-Type": "application/octet-stream",
    "Content-Length": String(size),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };

  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
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

  headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${S3_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  console.log(`[backup] Uploading to ${url} ...`);
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
