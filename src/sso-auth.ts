import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  errors as joseErrors,
} from "jose";
import type { SsoConfig } from "./deployment-config.js";

export interface SsoIdentity {
  email: string;
  claims: JWTPayload;
}

export type SsoFailureReason =
  | "disabled"
  | "missing_config"
  | "jwks_url_not_https"
  | "invalid_token"
  | "missing_email"
  | "verification_error";

export interface SsoVerifyResult {
  identity: SsoIdentity | null;
  failureReason?: SsoFailureReason;
}

type Verifier = (token: string) => Promise<SsoVerifyResult>;

export function validateSsoConfig(config: SsoConfig): string[] {
  const warnings: string[] = [];
  if (!config.enabled) return warnings;

  if (config.jwksUrl && !config.jwksUrl.startsWith("https://")) {
    warnings.push("RM_SSO_JWKS_URL should use HTTPS in production to prevent MITM attacks on key material");
  }
  if (!config.issuer) warnings.push("RM_SSO_ISSUER is required when SSO is enabled");
  if (!config.audience) warnings.push("RM_SSO_AUDIENCE is required when SSO is enabled");
  return warnings;
}

export function createSsoVerifier(config: SsoConfig): Verifier {
  if (!config.enabled) {
    return async () => ({ identity: null, failureReason: "disabled" });
  }
  if (!config.jwksUrl || !config.issuer || !config.audience) {
    return async () => ({ identity: null, failureReason: "missing_config" });
  }

  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  return async (token: string): Promise<SsoVerifyResult> => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer || undefined,
        audience: config.audience || undefined,
      });
      const emailRaw = payload[config.emailClaim];
      const email =
        typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : null;
      if (!email) return { identity: null, failureReason: "missing_email" };
      return { identity: { email, claims: payload } };
    } catch (error) {
      if (
        error instanceof joseErrors.JOSEError ||
        (error instanceof Error &&
          (error.message.includes("JWT") || error.message.includes("JWS")))
      ) {
        return { identity: null, failureReason: "invalid_token" };
      }
      return { identity: null, failureReason: "verification_error" };
    }
  };
}
