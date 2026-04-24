# U.S. Census Bureau Data API MCP — interactive fork

> **This is an unofficial fork** of [`uscensusbureau/us-census-bureau-data-api-mcp`](https://github.com/uscensusbureau/us-census-bureau-data-api-mcp), not operated or endorsed by the U.S. Census Bureau. The hosted endpoint below is run by [@tobinsouth](https://github.com/tobinsouth) on personal infrastructure. Data comes from the official Census Data API; see the upstream repo for the authoritative version.

Bringing official Census Bureau statistics to AI assistants **plus** an interactive Vega-Lite widget for maps and charts, hosted on Fly.io + Cloudflare for horizontal scaling.


<img width="827" height="1004" alt="CleanShot 2026-04-24 at 11 58 12@2x" src="https://github.com/user-attachments/assets/0a24c1ae-2338-448e-942c-6fa23af84169" />


---

## What this fork adds

On top of the upstream five tools (`list-datasets`, `fetch-dataset-geography`, `fetch-aggregate-data`, `resolve-geography-fips`, `search-data-tables`), this fork:

- **Replaces the Postgres metadata dependency with an embedded SQLite fixture** so the server is stateless and horizontally scalable. JS trigram port preserves `pg_trgm`-style ranking for fuzzy search.
- **Adds a streamable HTTP transport** (`src/http.ts`) — the server runs as a regular HTTP service instead of stdio only, so it can sit behind a load balancer / CDN.
- **Adds a `visualize-census` MCP App tool + Vega-Lite widget** — Claude authors a chart spec, the widget renders it inline in the conversation. Choropleths use `geoshape` + us-atlas TopoJSON with a lookup transform on a server-derived `__fips`; tabular charts are free-form. Hidden companion `get-topojson` tool serves boundaries to the widget only.
- **Authless by default** (Census data is public) with optional bearer auth via `MCP_AUTH_TOKEN`.
- **Tiered rate limit** — the Anthropic IP range (`160.79.104.0/21`, `2607:6bc0::/48`) shares a higher-capacity bucket; everyone else gets per-IP buckets.
- **Census API LRU + 60/min budget**, with automatic API-key redaction on every returned URL.
- **Ships production-ready** — `Dockerfile.http`, `fly.toml`, Cloudflare Rulesets-based edge rate limit. See [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Try it in Claude (hosted)

Base URL (currently serving from Fly):

```
https://census-mcp-bold-dream-9913.fly.dev/mcp
```

Custom hostname `https://census-mcp.tobinsouth.fyi/mcp` is being wired up behind Cloudflare for edge rate limiting — use whichever resolves for you.

### Claude.ai (web / Claude Desktop)

Settings → **Connectors** → **Add custom connector** → paste the URL above. No auth token needed. The server surfaces six model-visible tools plus the `visualize-census` widget.

### Claude Code

Put the following in `.mcp.json` at the root of any repo, or in `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "census": {
      "type": "http",
      "url": "https://census-mcp-bold-dream-9913.fly.dev/mcp"
    }
  }
}
```

Or run `/mcp` inside a Claude Code session and add it interactively.

### Verify

```bash
curl -s https://census-mcp-bold-dream-9913.fly.dev/healthz
# → {"status":"ok","sqlite":"/app/census-metadata.sqlite","authMode":"authless","ip":"…","anthropic":false}
```

---

## Example queries

Paste any of these into Claude after attaching the connector:

**Sanity check**

- _"What's the median household income in Travis County, Texas, for 2022?"_ — chains `resolve-geography-fips` → `fetch-aggregate-data` (B19013 = $92,731).
- _"Which Census table has data on language spoken at home?"_ — `search-data-tables`, returns B16005.

**Choropleth (the widget)**

- _"Map median household income by Texas county for 2022."_ — triggers `visualize-census` with `mark: "geoshape"`, `geo: {level: "counties"}`. 254 counties, auto-scoped, TopoJSON fetched behind the scenes.
- _"Make a US states choropleth of total population (B01003) using the ACS 5-year 2022."_ — full-US states map with `geo: {level: "states"}`.

**Multi-tool chains**

- _"Compare educational attainment (bachelor's+) in Travis, Harris, and Philadelphia counties for 2022."_ — three `resolve-geography-fips` calls, one `search-data-tables`, three `fetch-aggregate-data` calls, Claude reconciles into a table.

**Interactive click (widget + drill-in)**

- _"Make a Texas counties income map, and let me click a county to drill into its demographics."_ — sets `interactive.onClickSend: "Tell me about {NAME}"`; clicking a county sends that message back to the conversation.

---

## Tools + prompts (reference)

Upstream tools still present, same signatures:

| Tool                      | What it does                                                 |
| ------------------------- | ------------------------------------------------------------ |
| `list-datasets`           | Catalog of all Census datasets.                              |
| `fetch-dataset-geography` | Geography levels available for a dataset.                    |
| `fetch-aggregate-data`    | The actual data fetch (dataset + year + `get` + `for`/`in`). |
| `resolve-geography-fips`  | Place name → FIPS + query params.                            |
| `search-data-tables`      | Label query → ranked table IDs.                              |

New in this fork:

| Tool               | What it does                                                                                                                                 | Visibility                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `visualize-census` | Render a model-authored Vega-Lite spec with Census data. Supports pre-fetched `data` or an inline `fetch`. Choropleth-aware via `geo.level`. | Model + app                               |
| `get-topojson`     | Serves us-atlas state/county TopoJSON to the widget.                                                                                         | App-only (`_meta.ui.visibility: ['app']`) |

The `population` prompt from upstream is preserved.

---

## Self-host

The full deploy runbook — Docker image build, Fly launch, Cloudflare DNS/WAF — lives in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

Quick local start (SQLite, no Postgres needed):

```bash
cd mcp-server
npm ci
npm run build
npm run build:sqlite -- --fixture    # creates census-metadata.sqlite from mcp-db/data/
CENSUS_API_KEY=… SQLITE_PATH=./census-metadata.sqlite node dist/http.js
# server at http://localhost:3801/mcp
```

### Develop

```bash
cd mcp-server
npm run check    # typecheck + lint + format:check
npm test -- --run
npm run watch    # tsc --watch
```

CI runs the same `check` + `npm test` in `.github/workflows/`.

---

## Architecture

```
  Claude client
       │
       ▼
  Cloudflare (proxied DNS, edge rate limit on /mcp)
       │
       ▼
  Fly proxy + machine (iad) — TRUST_PROXY=2
       │
       ▼
  node dist/http.js
    ├─ StreamableHTTPServerTransport (MCP streamable HTTP)
    ├─ rate-limit middleware (Anthropic CIDR gets shared 600-cap bucket;
    │  everyone else per-IP 30-cap)
    ├─ tools/resources/prompts via MCPServer (src/server.ts)
    │    ├─ SQLite metadata (src/services/metadata.service.ts)
    │    ├─ Census API helper with LRU + budget + key redaction
    │    └─ visualize-census widget — Vega-Lite inside an iframe
    └─ /healthz echoes {ip, anthropic}
```

Key files:

- `mcp-server/src/http.ts` — HTTP entrypoint, auth guard, rate-limit mount.
- `mcp-server/src/server.ts` — `MCPServer` (tools/resources/prompts, `_meta` + `annotations` pass-through, tool visibility filter).
- `mcp-server/src/services/metadata.service.ts` — `MetadataService` + `SqliteMetadataService`.
- `mcp-server/src/services/census-api.service.ts` — `censusFetch()` (LRU + budget + redacted URL).
- `mcp-server/src/middleware/rate-limit.ts` — token buckets + Anthropic CIDR detection.
- `mcp-server/src/tools/visualize-census.tool.ts` + `src/widgets/visualize.html` — the widget.

---

## Credits

This fork is built on [`uscensusbureau/us-census-bureau-data-api-mcp`](https://github.com/uscensusbureau/us-census-bureau-data-api-mcp); the upstream team owns the official implementation, the data contracts, the authoritative tool schemas, and the detailed documentation. See [CONTRIBUTING.md](./CONTRIBUTING.md) and the upstream README for contributor guidance and deeper tool reference.

## License

CC0-1.0, matching upstream.
