# Enterprise Ops Checklist (Pass/Fail)

Use this for founder gate and release gate.

## Environment

- [ ] Deployment mode explicitly set (`self-host` or `isolated-hosted`)
- [ ] Tenant ID is set and documented
- [ ] Dedicated API/service keys generated for this tenant
- [ ] Env validation script passes

## Network boundary

- [ ] In self-host mode, ingress is private or restricted
- [ ] Public webhook bypass disabled unless explicitly approved
- [ ] Model egress policy set (`disabled` or allowlist)

## Auth and identity

- [ ] API key auth works
- [ ] Dashboard auth token path works
- [ ] Optional SSO path validates issuer/audience/JWKS
- [ ] Invalid/revoked credentials fail deterministically

## Data isolation

- [ ] Dedicated DB volume used
- [ ] No shared tenant keys or shared DB path
- [ ] Canary write/read isolation check passed

## Recoverability

- [ ] Backup job is configured and tested
- [ ] Restore into clean environment succeeded
- [ ] Post-restore smoke test passed

## Compatibility

- [ ] `/health` returns expected deployment fields
- [ ] `/mcp` and OAuth discovery still reachable when configured
- [ ] Existing dashboard/API client flows still pass

## Auditability

- [ ] `audit_events` table exists
- [ ] Auth failures are logged
- [ ] Sensitive route access is logged
