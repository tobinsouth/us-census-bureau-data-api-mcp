# Census MCP Deployment

This document covers the hosted deployment path for the streamable-HTTP
Census MCP: Fly.io for the stateless app tier, Cloudflare in front for
edge rate-limiting, WAF, and DNS.

## Architecture

```
  Claude client / browser
        │
        ▼
┌──────────────────────┐
│ Cloudflare (proxied) │
│  - DNS (AAAA/A)      │
│  - rate-limit /mcp   │
│  - WAF / bot rules   │
└──────────┬───────────┘
           │   X-Forwarded-For: <client>, <cloudflare>
           ▼
┌──────────────────────┐
│ Fly proxy + machine  │
│  - node dist/http.js │
│  - SQLite fixture    │
│  - TRUST_PROXY=2     │
└──────────────────────┘
```

`TRUST_PROXY=2` tells Express to honor the last **two** hops of
`X-Forwarded-For` (Cloudflare → Fly proxy), so `req.ip` reflects the real
client and the rate limiter classifies Anthropic vs public correctly.

## Fly.io

Config lives in `fly.toml` at the repo root; Docker image is built from
`mcp-server/Dockerfile.http` with the repo root as the build context
(`mcp-db/data/` must be visible during the build so the SQLite fixture
can seed).

First deploy:

```bash
# from repo root
fly launch --copy-config --name census-mcp --region iad --org personal --no-deploy --yes

# grab the Census key from your .env (or set it directly)
KEY=$(grep CENSUS_API_KEY .env | cut -d= -f2)
fly secrets set CENSUS_API_KEY="$KEY" --stage

fly deploy --remote-only
```

The app name that gets generated may differ if `census-mcp` is taken; Fly
returns something like `census-mcp-<slug>.fly.dev`. That hostname is the
origin for Cloudflare to point at.

**Subsequent deploys** after a push to `main`:

```bash
fly deploy --remote-only
```

**Smoke tests** against the Fly hostname:

```bash
HOST=census-mcp-bold-dream-9913.fly.dev

curl -s https://$HOST/healthz
# → {"status":"ok","sqlite":"/app/census-metadata.sqlite","authMode":"authless","ip":"…","anthropic":false}

curl -s -X POST https://$HOST/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 200
```

## Cloudflare

Wrangler's OAuth scope is Workers-only; zone DNS and rate-limit rules
need either a scoped API token (`CF_TOKEN`) or the dashboard.

For this deploy: zone `tobinsouth.fyi` (id
`becac57d61a855220190c9293d7b5742`), target host
`census-mcp.tobinsouth.fyi`.

### 1. DNS

Add a **proxied** CNAME record in the zone:

| Type   | Name         | Target                                    | Proxy |
|--------|--------------|-------------------------------------------|-------|
| CNAME  | `census-mcp` | `census-mcp-bold-dream-9913.fly.dev`      | ✅    |

Via API (requires a token with `Zone.DNS:Edit`):

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"census-mcp","content":"census-mcp-bold-dream-9913.fly.dev","proxied":true,"ttl":1}'
```

Fly issues the cert for `*.fly.dev`; Cloudflare terminates TLS on the
custom hostname. After propagation:

```bash
curl -s https://census-mcp.tobinsouth.fyi/healthz
```

### 2. Per-IP rate limit on `/mcp`

Deployed via the Rulesets API (free-plan tier requires `period=10s`,
`mitigation_timeout=10s`; to match the in-app 30/min cap we use
**5 requests / 10 seconds per IP per colo**):

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/rulesets" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "census-mcp edge rate limit",
    "kind": "zone",
    "phase": "http_ratelimit",
    "rules": [{
      "description": "census-mcp /mcp: 5 req / 10s per IP",
      "expression": "(http.host eq \"census-mcp.tobinsouth.fyi\" and starts_with(http.request.uri.path, \"/mcp\"))",
      "action": "block",
      "ratelimit": {
        "characteristics": ["ip.src", "cf.colo.id"],
        "period": 10,
        "requests_per_period": 5,
        "mitigation_timeout": 10
      }
    }]
  }'
```

Current ruleset id: `b2a178c944384ae0bc4a03c98e64d200` (rule
`9c74ef4c10f745b39aa314a8721e5bdd`). Adjust thresholds via
`PUT /rulesets/{id}/rules/{rule_id}`.

### 3. (Optional) WAF tag for Anthropic traffic

Dashboard → **Security** → **WAF** → **Custom rules** → new rule:

- **Match**: `ip.src in {160.79.104.0/21 2607:6bc0::/48}` AND
  `hostname equals census-mcp.<your-domain>`
- **Action**: `Log` and add a header via a **Transform Rule** (Managed
  Transforms → Modify Response / Request Headers), e.g.
  `X-Anthropic-Client: 1`

This is informational — the in-app rate limiter already classifies by
CIDR using the exact same ranges, so Anthropic traffic gets the higher
(shared) bucket regardless. The header just makes the classification
visible in Fly logs.

### 4. Verify

```bash
HOST=census-mcp.<your-domain>

# Should round-trip through Cloudflare
curl -sI https://$HOST/healthz | grep -iE '^cf-ray|^server'

# Burst until you get 429s from the Cloudflare rule
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" https://$HOST/healthz)
  echo $code
done | sort | uniq -c
```

You should see ~30 × 200 then a flip to 429, depending on the exact rule
threshold.

## Rollback / troubleshooting

- **Health check failing**: `fly logs --app <app>` will show the Node
  stderr. Common cause: missing `CENSUS_API_KEY` secret (stage + deploy)
  or SQLite fixture missing from the image.
- **Rebuild SQLite fixture**: redeployed on every `fly deploy` because
  `npm run build:sqlite -- --fixture` runs in the builder stage.
- **Scale**: `fly scale count 2` adds a replica; buckets in
  `src/middleware/rate-limit.ts` are per-process so each replica has its
  own quota. The Cloudflare rule is enforced globally.
