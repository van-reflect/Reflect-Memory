# IAM / SSO Integration Guide — Enterprise V1

## Overview

Reflect Memory supports enterprise SSO via OIDC (OpenID Connect) with JWKS-based token verification. This allows enterprise customers to authenticate users through their existing identity provider (IdP) without sharing API keys.

---

## Supported Identity Providers

Any OIDC-compliant IdP that publishes a JWKS endpoint:

| Provider | JWKS URL pattern | Notes |
|----------|------------------|-------|
| Okta | `https://{domain}/.well-known/jwks.json` | Supports custom claims |
| Azure AD | `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys` | Use v2.0 endpoint |
| Google Workspace | `https://www.googleapis.com/oauth2/v3/certs` | Email in `email` claim |
| Auth0 | `https://{domain}/.well-known/jwks.json` | Supports custom audiences |
| Keycloak | `https://{host}/realms/{realm}/protocol/openid-connect/certs` | Self-hosted option |

### SAML-only IdPs

If your IdP only supports SAML, deploy a SAML-to-OIDC bridge:
- **Keycloak** (recommended for self-host): Acts as SAML SP and OIDC IdP
- **Dex** (lightweight): Kubernetes-native OIDC bridge
- **Okta**: Can act as both SAML SP and OIDC IdP simultaneously

---

## Configuration

### Environment variables

```bash
# Enable SSO
RM_SSO_ENABLED=true

# JWKS endpoint URL (MUST be HTTPS in production)
RM_SSO_JWKS_URL=https://idp.example.com/.well-known/jwks.json

# Token issuer (must match the `iss` claim in JWTs)
RM_SSO_ISSUER=https://idp.example.com/

# Token audience (must match the `aud` claim in JWTs)
RM_SSO_AUDIENCE=reflect-memory

# Email claim name (default: "email")
# Some IdPs use custom claim names like "preferred_username" or "upn"
RM_SSO_EMAIL_CLAIM=email
```

### Validation at startup

When SSO is enabled, the server validates:
1. `RM_SSO_JWKS_URL` is set and reachable
2. `RM_SSO_ISSUER` is set
3. `RM_SSO_AUDIENCE` is set
4. If JWKS URL is not HTTPS, a warning is logged

If any required field is missing, the server fails to start with a clear error message.

---

## How Authentication Works

### Flow

1. User obtains a JWT from their IdP (via OIDC login flow)
2. User sends the JWT as a Bearer token: `Authorization: Bearer <jwt>`
3. Reflect Memory:
   a. Detects the token looks like a JWT (contains dots, 3 segments)
   b. Fetches the IdP's JWKS keys (cached by the `jose` library)
   c. Verifies the JWT signature against the JWKS
   d. Validates `iss` (issuer) and `aud` (audience) claims
   e. Extracts the email from the configured claim
   f. Looks up or creates a user with that email (`findOrCreateUserByEmail`)
   g. Grants `user` role access

### Auth priority

SSO is checked **after** dashboard auth and **before** static API key auth:

```
1. Dashboard service key + JWT  →  dashboard user
2. SSO bearer token (if enabled) →  SSO user
3. Static RM_API_KEY            →  owner user
4. Agent keys (RM_AGENT_KEY_*)  →  agent role
5. DB-stored per-user keys      →  user
6. None match                   →  401
```

This means SSO tokens are only attempted when:
- `RM_SSO_ENABLED=true`
- The token looks like a JWT
- The token is NOT the dashboard service key

### Failure behavior

If SSO verification fails (invalid signature, expired token, wrong issuer/audience), the auth hook falls through to try other auth methods. This means:
- A user with both an SSO token and an API key can use either
- An invalid SSO token does not block API key auth
- SSO failures for reasons other than simple invalid tokens are logged as audit events

---

## IdP Configuration

### What to configure in your IdP

1. **Create an application/client** for Reflect Memory
2. **Set the audience** to `reflect-memory` (or your custom value matching `RM_SSO_AUDIENCE`)
3. **Ensure the `email` claim** (or your custom claim) is included in the JWT
4. **Note the issuer URL** — this goes in `RM_SSO_ISSUER`
5. **Note the JWKS URL** — this goes in `RM_SSO_JWKS_URL`

### Okta example

```
Application type: API / Machine-to-Machine
Audience: reflect-memory
Issuer: https://your-org.okta.com/oauth2/default
JWKS: https://your-org.okta.com/oauth2/default/v1/keys
Claims: email (standard)
```

### Azure AD example

```
Application type: App registration
Audience: api://reflect-memory
Issuer: https://login.microsoftonline.com/{tenant-id}/v2.0
JWKS: https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys
Claims: email or preferred_username
```

---

## Testing SSO

### 1. Verify configuration

```bash
# Check that SSO is enabled in health response
curl -s http://localhost:3000/health | python3 -m json.tool
# Look for deployment_mode and verify the service is running
```

### 2. Test with a valid JWT

```bash
# Obtain a JWT from your IdP (method varies by provider)
# Then test it:
curl -s http://localhost:3000/whoami \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..." \
  | python3 -m json.tool
```

Expected response:
```json
{
  "user_id": "...",
  "role": "user",
  "vendor": null
}
```

### 3. Test with an invalid JWT

```bash
curl -s http://localhost:3000/whoami \
  -H "Authorization: Bearer invalid.jwt.token"
# Should return 401 (falls through all auth methods)
```

### 4. Check audit events

```bash
curl -s "http://localhost:3000/admin/audit?event_type=security.sso_auth_failure" \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -m json.tool
```

---

## Security Considerations

1. **JWKS URL must be HTTPS** in production. HTTP JWKS URLs allow MITM attacks on key material.
2. **Issuer and audience must be specific.** Do not use wildcard values.
3. **Email claim must be verified by the IdP.** Unverified email claims allow identity spoofing.
4. **Token lifetime should be short** (15 minutes to 1 hour). Reflect Memory does not maintain a session; each request re-verifies the JWT.
5. **Key rotation** is handled automatically by JWKS. When the IdP rotates keys, the `jose` library fetches the new keyset.

---

## V2 Roadmap

- **SCIM provisioning:** Automatic user creation/deactivation from IdP
- **Group/role mapping:** Map IdP groups to Reflect Memory roles
- **Session management:** IdP logout signals (back-channel logout)
- **MFA enforcement:** Require `amr` claim to include MFA method
