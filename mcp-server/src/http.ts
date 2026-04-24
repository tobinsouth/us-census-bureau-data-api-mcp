import 'dotenv/config'

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { MCPServer } from './server.js'
import {
  getClientIp,
  isAnthropicIp,
  rateLimit,
  type RateLimitLocals,
} from './middleware/rate-limit.js'
import {
  SqliteMetadataService,
  setMetadataService,
} from './services/metadata.service.js'
import { FetchAggregateDataTool } from './tools/fetch-aggregate-data.tool.js'
import { FetchDatasetGeographyTool } from './tools/fetch-dataset-geography.tool.js'
import { GetTopoJsonTool } from './tools/get-topojson.tool.js'
import { ListDatasetsTool } from './tools/list-datasets.tool.js'
import { ResolveGeographyFipsTool } from './tools/resolve-geography-fips.tool.js'
import { SearchDataTablesTool } from './tools/search-data-tables.tool.js'
import { VisualizeCensusTool } from './tools/visualize-census.tool.js'
import { PopulationPrompt } from './prompts/population.prompt.js'
import { loadVisualizeWidget } from './widgets/widget-loader.js'

const PORT = Number(process.env.PORT ?? 3801)
const SQLITE_PATH = resolve(
  process.env.SQLITE_PATH ?? './census-metadata.sqlite',
)

// TRUST_PROXY parsing:
//   unset     → false (node sees raw socket, no X-Forwarded-For trust)
//   numeric   → number of proxy hops to trust
//   "true"    → boolean true (dev/test only — trusts any forwarded header)
function parseTrustProxy(raw: string | undefined): boolean | number {
  if (!raw) return false
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 0 && String(n) === raw.trim()) return n
  if (raw === 'true') return true
  return false
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY)

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN
const AUTH_MODE = MCP_AUTH_TOKEN ? 'bearer' : 'authless'

// Hard-pin the SQLite backend before any tool constructor runs.
setMetadataService(new SqliteMetadataService(SQLITE_PATH))

// Load the visualize widget once — inlining ~1.15MB of bundles is slow.
const VISUALIZE_WIDGET = loadVisualizeWidget()
const VISUALIZE_RESOURCE_URI = 'ui://widgets/visualize.html'
const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app'
console.log(
  `visualize widget loaded (${Math.round(VISUALIZE_WIDGET.bytes / 1024)}KB)`,
)

function createServer(): MCPServer {
  const server = new MCPServer('census-api', '0.1.0')
  server.registerPrompt(new PopulationPrompt())
  server.registerTool(new FetchAggregateDataTool())
  server.registerTool(new FetchDatasetGeographyTool())
  server.registerTool(new ListDatasetsTool())
  server.registerTool(new ResolveGeographyFipsTool())
  server.registerTool(new SearchDataTablesTool())
  server.registerTool(new VisualizeCensusTool())
  server.registerTool(new GetTopoJsonTool())

  server.registerResource({
    uri: VISUALIZE_RESOURCE_URI,
    name: 'Census Visualizer',
    description:
      'Interactive Vega-Lite widget rendered by the visualize-census tool.',
    mimeType: WIDGET_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
    read: async () => ({
      contents: [
        {
          uri: VISUALIZE_RESOURCE_URI,
          mimeType: WIDGET_MIME_TYPE,
          text: VISUALIZE_WIDGET.html,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  })

  return server
}

function authGuard(req: Request, res: Response, next: NextFunction): void {
  if (!MCP_AUTH_TOKEN) {
    next()
    return
  }
  const header = req.headers.authorization
  const match =
    typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null
  if (!match) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="census-mcp"')
      .json({ error: 'Unauthorized' })
    return
  }
  const provided = Buffer.from(match[1])
  const expected = Buffer.from(MCP_AUTH_TOKEN)
  const equalLen = provided.length === expected.length
  // timingSafeEqual requires equal-length buffers — pad to prevent early exit.
  const a = equalLen ? provided : Buffer.alloc(expected.length)
  const b = expected
  if (!equalLen || !timingSafeEqual(a, b)) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="census-mcp"')
      .json({ error: 'Unauthorized' })
    return
  }
  next()
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const requestId = randomUUID()
  const started = Date.now()
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  res.on('close', () => {
    void transport.close().catch(() => {})
    void server.close().catch(() => {})
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    const ms = Date.now() - started
    const tier = (res.locals as RateLimitLocals).rateTier ?? 'unknown'
    console.log(
      `[${requestId}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms tier=${tier}`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${requestId}] handler error: ${message}`)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
}

const app = express()
app.set('trust proxy', TRUST_PROXY)

app.use(express.json({ limit: '4mb' }))

app.get('/healthz', (req, res) => {
  const ip = getClientIp(req)
  res.json({
    status: 'ok',
    sqlite: SQLITE_PATH,
    authMode: AUTH_MODE,
    ip,
    anthropic: isAnthropicIp(ip),
  })
})

// Rate limit + auth apply to /mcp only; /healthz stays open so probes still
// work when buckets are drained.
const mcpHandler = (req: Request, res: Response): void => {
  void handleMcpRequest(req, res)
}
app.post('/mcp', rateLimit(), authGuard, mcpHandler)
// StreamableHTTP transport also supports GET (SSE resume) and DELETE (session close).
app.get('/mcp', rateLimit(), authGuard, mcpHandler)
app.delete('/mcp', rateLimit(), authGuard, mcpHandler)

const server = app.listen(PORT, () => {
  console.log(
    `census-mcp HTTP :${PORT} auth=${AUTH_MODE} trustProxy=${TRUST_PROXY} sqlite=${SQLITE_PATH}`,
  )
})

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`)
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
