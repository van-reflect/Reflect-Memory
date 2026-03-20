# Audit Pipeline — Operational Runbook

## Overview

The audit pipeline captures all security-sensitive operations into the `audit_events` SQLite table. It supports querying, export, and automated retention pruning.

---

## What Gets Audited

| Event type | Trigger | Severity |
|------------|---------|----------|
| `security.auth_missing` | Request without Authorization header | warn |
| `security.auth_empty` | Empty Bearer token | warn |
| `security.auth_invalid_key` | Invalid API key | warn |
| `security.dashboard_token_missing` | Dashboard auth without X-Dashboard-Token | warn |
| `security.dashboard_token_invalid` | Invalid dashboard JWT | warn |
| `security.dashboard_token_expired` | Expired dashboard JWT | warn |
| `security.agent_route_forbidden` | Agent key accessing restricted route | warn |
| `sensitive.route_access` | Any access to memories, admin, oauth, keys, webhooks | info/warn |

### Fields captured per event

- `id` — unique event UUID
- `user_id` — authenticated user (null for failed auth)
- `event_type` — category string
- `severity` — info, warn, or error
- `auth_method` — api_key, agent_key, dashboard, sso
- `vendor` — agent vendor name (if applicable)
- `path` — request path (query string stripped)
- `status_code` — HTTP response code
- `ip` — client IP address
- `request_id` — X-Request-Id header value (if provided)
- `metadata` — JSON blob with additional context
- `created_at` — ISO 8601 timestamp

---

## Querying Audit Events

### Via API

```bash
# Get recent auth failures
curl -s http://localhost:3000/admin/audit?severity=warn&limit=20 \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -m json.tool

# Get events for a specific user
curl -s "http://localhost:3000/admin/audit?user_id=USER_UUID&limit=50" \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -m json.tool

# Get events by type
curl -s "http://localhost:3000/admin/audit?event_type=security.auth_invalid_key" \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -m json.tool

# Get events in a time range
curl -s "http://localhost:3000/admin/audit?since=2026-02-01T00:00:00Z&until=2026-02-08T23:59:59Z" \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -m json.tool
```

### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `event_type` | string | Filter by event type |
| `user_id` | string | Filter by user UUID |
| `severity` | string | Filter by severity (info, warn, error) |
| `since` | ISO 8601 | Events after this timestamp |
| `until` | ISO 8601 | Events before this timestamp |
| `limit` | number | Max results (default 100, max 1000) |
| `offset` | number | Skip N results for pagination |

### Response format

```json
{
  "events": [
    {
      "id": "...",
      "user_id": "...",
      "event_type": "security.auth_invalid_key",
      "severity": "warn",
      "auth_method": null,
      "vendor": null,
      "path": "/memories/list",
      "status_code": 401,
      "ip": "192.168.1.100",
      "request_id": null,
      "metadata": null,
      "created_at": "2026-02-08T12:34:56.789Z"
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

---

## Exporting Audit Events

For compliance archival, export events for a specific time range:

```bash
curl -s "http://localhost:3000/admin/audit/export?since=2026-01-01T00:00:00Z&until=2026-02-01T00:00:00Z" \
  -H "Authorization: Bearer $RM_API_KEY" \
  -o audit-export-january-2026.json
```

The response includes a `Content-Disposition` header for download. The JSON file contains all events in chronological order.

---

## Retention & Pruning

### Configuration

Set `RM_AUDIT_RETENTION_DAYS` in your environment (default: 90 days).

```bash
RM_AUDIT_RETENTION_DAYS=90
```

### How it works

- Pruning runs automatically once per day (first run 60 seconds after startup, then every 24 hours)
- Events older than the retention period are permanently deleted
- Pruning is logged: `[audit] Pruned N events older than 90 days`
- Set `RM_AUDIT_RETENTION_DAYS=0` to disable pruning (events accumulate indefinitely)

### Manual pruning

If you need to prune immediately, restart the service. Pruning runs 60 seconds after startup.

### Storage estimation

- Each audit event is approximately 500 bytes to 1 KB
- At 100 events/day with 90-day retention: ~9,000 events ≈ 5-9 MB
- At 1,000 events/day with 90-day retention: ~90,000 events ≈ 50-90 MB

---

## Monitoring Recommendations

### Alert on high auth failure rate

Query the audit API periodically and alert if `security.auth_invalid_key` events exceed a threshold:

```bash
COUNT=$(curl -s "http://localhost:3000/admin/audit?event_type=security.auth_invalid_key&since=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)&limit=1" \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")

if [ "$COUNT" -gt 50 ]; then
  echo "ALERT: $COUNT auth failures in the last hour"
fi
```

### Alert on sensitive route access from unexpected IPs

```bash
curl -s "http://localhost:3000/admin/audit?event_type=sensitive.route_access&since=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)&limit=100" \
  -H "Authorization: Bearer $RM_API_KEY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
ips = set(e['ip'] for e in data['events'])
print('Unique IPs in last hour:', ips)
"
```

---

## Backup Considerations

Audit events are stored in the same SQLite database as all other data. When you back up the database file, audit events are included automatically. No separate backup procedure is needed.

For compliance that requires separate audit storage, use the export endpoint to periodically archive audit data to an external system before pruning removes it.
