// Deployment configuration abstraction for enterprise hosting modes.
// Centralizes mode toggles so runtime behavior can be switched safely.

export type DeploymentMode = "hosted" | "isolated-hosted" | "self-host";

export interface SsoConfig {
  enabled: boolean;
  jwksUrl: string | null;
  issuer: string | null;
  audience: string | null;
  emailClaim: string;
}

export interface DeploymentConfig {
  mode: DeploymentMode;
  tenantId: string | null;
  networkBoundary: "public" | "private";
  disableModelEgress: boolean;
  requireInternalModelBaseUrl: boolean;
  allowPublicWebhooks: boolean;
  allowedModelHosts: string[];
  sso: SsoConfig;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseMode(value: string | undefined): DeploymentMode {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "isolated-hosted") return "isolated-hosted";
  if (normalized === "self-host" || normalized === "selfhost") return "self-host";
  return "hosted";
}

function parseAllowedHosts(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveDeploymentConfig(env: NodeJS.ProcessEnv): DeploymentConfig {
  const mode = parseMode(env.RM_DEPLOYMENT_MODE);
  const networkBoundary = mode === "self-host" ? "private" : "public";

  const defaultDisableModelEgress = mode === "self-host";
  const disableModelEgress = parseBool(
    env.RM_DISABLE_MODEL_EGRESS,
    defaultDisableModelEgress,
  );
  const requireInternalModelBaseUrl = parseBool(
    env.RM_REQUIRE_INTERNAL_MODEL_BASE_URL,
    mode === "self-host",
  );
  const allowPublicWebhooks = parseBool(
    env.RM_ALLOW_PUBLIC_WEBHOOKS,
    mode !== "self-host",
  );

  const jwksUrl = env.RM_SSO_JWKS_URL?.trim() || null;
  const issuer = env.RM_SSO_ISSUER?.trim() || null;
  const audience = env.RM_SSO_AUDIENCE?.trim() || null;
  const emailClaim = env.RM_SSO_EMAIL_CLAIM?.trim() || "email";
  const ssoEnabled = parseBool(env.RM_SSO_ENABLED, false);

  return {
    mode,
    tenantId: env.RM_TENANT_ID?.trim() || null,
    networkBoundary,
    disableModelEgress,
    requireInternalModelBaseUrl,
    allowPublicWebhooks,
    allowedModelHosts: parseAllowedHosts(env.RM_ALLOWED_MODEL_HOSTS),
    sso: {
      enabled: ssoEnabled,
      jwksUrl,
      issuer,
      audience,
      emailClaim,
    },
  };
}

export function validateDeploymentConfig(config: DeploymentConfig): void {
  if (config.sso.enabled) {
    if (!config.sso.jwksUrl) {
      throw new Error("RM_SSO_ENABLED requires RM_SSO_JWKS_URL");
    }
    if (!config.sso.issuer) {
      throw new Error("RM_SSO_ENABLED requires RM_SSO_ISSUER");
    }
    if (!config.sso.audience) {
      throw new Error("RM_SSO_ENABLED requires RM_SSO_AUDIENCE");
    }
  }

  if (config.mode === "self-host" && config.requireInternalModelBaseUrl && config.allowedModelHosts.length === 0) {
    throw new Error(
      "self-host mode with RM_REQUIRE_INTERNAL_MODEL_BASE_URL=true requires RM_ALLOWED_MODEL_HOSTS to be set",
    );
  }
}

export function freezeDeploymentConfig(config: DeploymentConfig): Readonly<DeploymentConfig> {
  Object.freeze(config.sso);
  Object.freeze(config.allowedModelHosts);
  return Object.freeze(config);
}

export function enforceModelHostPolicy(
  baseUrl: string,
  config: DeploymentConfig,
  envName: string,
): void {
  if (config.allowedModelHosts.length === 0) return;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`${envName} is not a valid URL: ${baseUrl}`);
  }
  if (!config.allowedModelHosts.includes(host)) {
    throw new Error(
      `${envName} host "${host}" is not in RM_ALLOWED_MODEL_HOSTS`,
    );
  }
}
