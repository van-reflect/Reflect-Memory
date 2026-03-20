# Deployment Config Modes

Use env-only switches to run one codebase across hosted and enterprise deployments.

## Mode matrix

| Variable | hosted | isolated-hosted | self-host |
| --- | --- | --- | --- |
| `RM_DEPLOYMENT_MODE` | `hosted` | `isolated-hosted` | `self-host` |
| `RM_DISABLE_MODEL_EGRESS` | `false` | `false` | `true` (default) |
| `RM_REQUIRE_INTERNAL_MODEL_BASE_URL` | `false` | `false` | `true` (default) |
| `RM_ALLOW_PUBLIC_WEBHOOKS` | `true` | `true` | `false` (default) |
| `RM_TENANT_ID` | optional | required | required |

## Hosted baseline

```
RM_DEPLOYMENT_MODE=hosted
RM_DISABLE_MODEL_EGRESS=false
RM_ALLOW_PUBLIC_WEBHOOKS=true
```

## Isolated-hosted baseline

```
RM_DEPLOYMENT_MODE=isolated-hosted
RM_TENANT_ID=enterprise-acme-prod
RM_DISABLE_MODEL_EGRESS=false
RM_ALLOW_PUBLIC_WEBHOOKS=true
```

## Self-host baseline

```
RM_DEPLOYMENT_MODE=self-host
RM_TENANT_ID=customer-a
RM_DISABLE_MODEL_EGRESS=true
RM_REQUIRE_INTERNAL_MODEL_BASE_URL=true
RM_ALLOW_PUBLIC_WEBHOOKS=false
RM_ALLOWED_MODEL_HOSTS=llm-gateway.internal.example
```

## Optional enterprise SSO

```
RM_SSO_ENABLED=true
RM_SSO_JWKS_URL=https://idp.example.com/.well-known/jwks.json
RM_SSO_ISSUER=https://idp.example.com/
RM_SSO_AUDIENCE=reflect-memory
RM_SSO_EMAIL_CLAIM=email
```

## Notes

- If `RM_DISABLE_MODEL_EGRESS=true`, `/query` and `/chat` return `503` by policy.
- If `RM_REQUIRE_INTERNAL_MODEL_BASE_URL=true`, public model hosts are rejected at boot.
- Restrict webhook exposure in private mode unless explicitly enabled.
