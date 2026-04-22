#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), process.argv[2] || ".env.enterprise");
const raw = readFileSync(envPath, "utf8");

const env = Object.fromEntries(
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)];
    }),
);

const required = [
  "RM_DEPLOYMENT_MODE",
  "RM_TENANT_ID",
  "RM_API_KEY",
  "RM_DASHBOARD_SERVICE_KEY",
  "RM_DASHBOARD_JWT_SECRET",
];

const errors = [];
for (const key of required) {
  if (!env[key] || env[key].trim().length === 0) {
    errors.push(`Missing required value: ${key}`);
  }
}

// Owner identity: require at least one of RM_OWNER_EMAIL (singular, primary)
// or RM_OWNER_EMAILS (plural, comma-separated superset). Enterprise deploys
// may set either; the app treats both as additive at boot.
const ownerEmail = (env.RM_OWNER_EMAIL ?? "").trim();
const ownerEmails = (env.RM_OWNER_EMAILS ?? "").trim();
if (!ownerEmail && !ownerEmails) {
  errors.push("Missing required value: RM_OWNER_EMAIL or RM_OWNER_EMAILS (at least one)");
}

if (env.RM_DEPLOYMENT_MODE !== "self-host" && env.RM_DEPLOYMENT_MODE !== "isolated-hosted") {
  errors.push("RM_DEPLOYMENT_MODE must be self-host or isolated-hosted for enterprise runs");
}

if (env.RM_DEPLOYMENT_MODE === "self-host") {
  if (env.RM_DISABLE_MODEL_EGRESS !== "true" && !env.RM_ALLOWED_MODEL_HOSTS) {
    errors.push(
      "self-host requires RM_DISABLE_MODEL_EGRESS=true or an explicit RM_ALLOWED_MODEL_HOSTS allowlist",
    );
  }
  if (env.RM_ALLOW_PUBLIC_WEBHOOKS === "true") {
    errors.push("self-host should keep RM_ALLOW_PUBLIC_WEBHOOKS=false unless explicitly approved");
  }
}

if (env.RM_SSO_ENABLED === "true") {
  for (const key of ["RM_SSO_JWKS_URL", "RM_SSO_ISSUER", "RM_SSO_AUDIENCE"]) {
    if (!env[key]) errors.push(`RM_SSO_ENABLED=true requires ${key}`);
  }
}

if (errors.length > 0) {
  console.error("Enterprise env validation failed:");
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log("Enterprise env validation passed.");
