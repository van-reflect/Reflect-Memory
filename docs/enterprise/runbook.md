# Enterprise Private Instance Starter Runbook

This is the fast path to run a private enterprise instance.

## 1) Generate baseline env

```bash
bash scripts/enterprise-bootstrap.sh .env.enterprise
```

## 2) Validate required security settings

```bash
node scripts/validate-enterprise-env.mjs .env.enterprise
```

Expected output:

```
Enterprise env validation passed.
```

## 3) Start service

Self-host profile:

```bash
docker compose --env-file .env.enterprise --profile self-host up --build -d
```

Isolated-hosted profile:

```bash
docker compose --env-file .env.enterprise --profile isolated-hosted up --build -d
```

## 4) Verify health and mode

```bash
curl -s http://127.0.0.1:3000/health
```

Check:

- `status` is `ok`
- `deployment_mode` matches expected mode
- `model_egress` matches policy

## 5) Run smoke test

```bash
export RM_SMOKE_API_KEY="your RM_API_KEY value"
node scripts/smoke-test-enterprise.mjs
```

Expected output:

```
Enterprise smoke test passed.
```

## 6) Upgrade path starter

- Pull latest code.
- Rebuild image with pinned tag.
- Start one replica in maintenance window.
- Confirm `/health`, auth, and smoke tests.
- Roll forward only after checks pass.

## 7) Backup and restore starter flow

- Trigger backup:
  - `npm run backup`
- Validate object exists in backup bucket.
- Restore by replacing DB file in a clean environment and re-running smoke test.
