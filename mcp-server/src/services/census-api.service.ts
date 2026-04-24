import { TableArgs } from '../schema/fetch-aggregate-data.schema.js'

export interface CensusFetchResult {
  /** URL with the API key redacted. Safe to return to callers or log. */
  url: string
  headers: string[]
  rows: string[][]
  cached: boolean
}

export interface CensusFetchOptions {
  signal?: AbortSignal
}

export class CensusRateLimitError extends Error {
  retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'CensusRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

export function buildCensusUrl(args: TableArgs, apiKey: string): string {
  const baseUrl = `https://api.census.gov/data/${args.year}/${args.dataset}`

  let getParams = ''
  if (args.get.variables || args.get.group) {
    if (args.get.variables) getParams = args.get.variables.join(',')
    if (args.get.group) {
      if (getParams !== '') getParams += ','
      getParams += `group(${args.get.group})`
    }
  }

  const query = new URLSearchParams({ get: getParams })
  if (args.for) query.append('for', args.for)
  if (args.in) query.append('in', args.in)
  if (args.ucgid) query.append('ucgid', args.ucgid)
  if (args.predicates) {
    for (const [key, value] of Object.entries(args.predicates)) {
      query.append(key, value)
    }
  }
  const descriptive = args.descriptive?.toString() ?? 'false'
  query.append('descriptive', descriptive)
  query.append('key', apiKey)

  return `${baseUrl}?${query.toString()}`
}

function redactApiKey(url: string, apiKey: string): string {
  if (!apiKey) return url
  // The key can arrive URL-encoded (URLSearchParams encodes it) or plain; redact both shapes.
  return url
    .replaceAll(`key=${encodeURIComponent(apiKey)}`, 'key=REDACTED')
    .replaceAll(`key=${apiKey}`, 'key=REDACTED')
}

// --- LRU cache + rolling-window rate budget -------------------------------
// The cache key MUST NOT contain the API key (rotations shouldn't invalidate
// entries; logs/dumps should never expose the key). The key is stripped before
// we derive the cache key.

const CACHE_MAX = 200
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const BUDGET_WINDOW_MS = 60 * 1000
const BUDGET_LIMIT = 60

interface CacheEntry {
  expiresAt: number
  payload: string[][]
}

const cache = new Map<string, CacheEntry>()
const callTimestamps: number[] = []

function pruneBudget(now: number): void {
  const cutoff = now - BUDGET_WINDOW_MS
  while (callTimestamps.length && callTimestamps[0] < cutoff) {
    callTimestamps.shift()
  }
}

function reserveBudget(now: number): void {
  pruneBudget(now)
  if (callTimestamps.length >= BUDGET_LIMIT) {
    const retryAfter = BUDGET_WINDOW_MS - (now - callTimestamps[0])
    throw new CensusRateLimitError(
      `Census API budget exhausted (${BUDGET_LIMIT}/min). Retry in ${Math.ceil(retryAfter / 1000)}s.`,
      retryAfter,
    )
  }
  callTimestamps.push(now)
}

function cacheGet(key: string): string[][] | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    cache.delete(key)
    return undefined
  }
  // Touch for LRU eviction order.
  cache.delete(key)
  cache.set(key, entry)
  return entry.payload
}

function cacheSet(key: string, payload: string[][]): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload })
}

function cacheKey(urlWithKey: string, apiKey: string): string {
  // Strip the API key before hashing — cache keys must never contain it.
  return urlWithKey
    .replaceAll(`key=${encodeURIComponent(apiKey)}`, 'key=')
    .replaceAll(`key=${apiKey}`, 'key=')
}

export async function censusFetch(
  args: TableArgs,
  apiKey: string,
  options: CensusFetchOptions = {},
): Promise<CensusFetchResult> {
  const fullUrl = buildCensusUrl(args, apiKey)
  const redactedUrl = redactApiKey(fullUrl, apiKey)
  const key = cacheKey(fullUrl, apiKey)

  const cached = cacheGet(key)
  if (cached) {
    const [headers, ...rows] = cached
    return { url: redactedUrl, headers: headers ?? [], rows, cached: true }
  }

  reserveBudget(Date.now())

  const fetchImpl = (await import('node-fetch')).default
  const res = options.signal
    ? await fetchImpl(fullUrl, { signal: options.signal })
    : await fetchImpl(fullUrl)
  if (!res.ok) {
    throw new Error(`Census API error: ${res.status} ${res.statusText}`)
  }
  const payload = (await res.json()) as string[][]
  if (!Array.isArray(payload)) {
    return { url: redactedUrl, headers: [], rows: [], cached: false }
  }
  cacheSet(key, payload)
  if (payload.length === 0) return { url: redactedUrl, headers: [], rows: [], cached: false }
  const [headers, ...rows] = payload
  return { url: redactedUrl, headers, rows, cached: false }
}

/** Drops every cached Census response. Use from test setup or on key rotation. */
export function clearCensusCache(): void {
  cache.clear()
  callTimestamps.length = 0
}
