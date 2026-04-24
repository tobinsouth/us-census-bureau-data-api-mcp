import type { NextFunction, Request, Response } from 'express'

// --- IP parsing ------------------------------------------------------------

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n < 0 || n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

function parseIpv6(ip: string): bigint | null {
  const lower = ip.toLowerCase()
  const halves = lower.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && fill < 0) return null
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail]
  if (groups.length !== 8) return null
  let out = 0n
  for (const g of groups) {
    const n = parseInt(g || '0', 16)
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null
    out = (out << 16n) | BigInt(n)
  }
  return out
}

// --- Anthropic IP ranges ---------------------------------------------------
//   160.79.104.0/21    (IPv4)
//   2607:6bc0::/48     (IPv6)

const ANTHROPIC_V4_NET = parseIpv4('160.79.104.0')!
const ANTHROPIC_V4_MASK = (0xffffffff << (32 - 21)) >>> 0
const ANTHROPIC_V6_NET = parseIpv6('2607:6bc0::')!
const ANTHROPIC_V6_SHIFT = BigInt(128 - 48)

export function isAnthropicIp(raw: string | undefined | null): boolean {
  if (!raw) return false
  let ip = raw.trim()
  // Express can return `::ffff:1.2.3.4` (IPv4-mapped IPv6).
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)

  const v4 = parseIpv4(ip)
  if (v4 !== null) {
    return (v4 & ANTHROPIC_V4_MASK) === (ANTHROPIC_V4_NET & ANTHROPIC_V4_MASK)
  }
  const v6 = parseIpv6(ip)
  if (v6 !== null) {
    return v6 >> ANTHROPIC_V6_SHIFT === ANTHROPIC_V6_NET >> ANTHROPIC_V6_SHIFT
  }
  return false
}

// --- Token bucket ----------------------------------------------------------

interface Bucket {
  tokens: number
  lastRefill: number
}

function refillAndTake(
  bucket: Bucket,
  capacity: number,
  refillPerSec: number,
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now()
  const elapsedSec = (now - bucket.lastRefill) / 1000
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec)
  bucket.lastRefill = now

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, retryAfterMs: 0 }
  }
  const deficit = 1 - bucket.tokens
  return { ok: false, retryAfterMs: Math.ceil((deficit / refillPerSec) * 1000) }
}

// --- Tiered limits ---------------------------------------------------------
//   anthropic: shared bucket — cap 600, refill 100/s
//   other    : per-IP       — cap 30,  refill 2/s

const ANTHROPIC_CAP = 600
const ANTHROPIC_REFILL = 100
const OTHER_CAP = 30
const OTHER_REFILL = 2

const OTHER_MAX_TRACKED = 10_000

const anthropicBucket: Bucket = {
  tokens: ANTHROPIC_CAP,
  lastRefill: Date.now(),
}
const otherBuckets = new Map<string, Bucket>()

export type RateTier = 'anthropic' | 'other'

export interface RateLimitLocals {
  rateTier?: RateTier
}

export function getClientIp(req: Request): string {
  // Express honors X-Forwarded-For when `trust proxy` is configured.
  // Fall back to the raw socket address when absent.
  return (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

function evictIfFull(): void {
  if (otherBuckets.size <= OTHER_MAX_TRACKED) return
  // Drop the oldest entry (Map preserves insertion order).
  const first = otherBuckets.keys().next().value
  if (first !== undefined) otherBuckets.delete(first)
}

function send429(res: Response, retryAfterMs: number): void {
  const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  res
    .status(429)
    .set('Retry-After', String(retrySec))
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32003,
        message: 'Rate limit exceeded',
        data: { retryAfterMs },
      },
      id: null,
    })
}

export function rateLimit() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req)
    const locals = res.locals as RateLimitLocals
    if (isAnthropicIp(ip)) {
      locals.rateTier = 'anthropic'
      const { ok, retryAfterMs } = refillAndTake(
        anthropicBucket,
        ANTHROPIC_CAP,
        ANTHROPIC_REFILL,
      )
      if (!ok) {
        send429(res, retryAfterMs)
        return
      }
      next()
      return
    }

    locals.rateTier = 'other'
    let bucket = otherBuckets.get(ip)
    if (!bucket) {
      bucket = { tokens: OTHER_CAP, lastRefill: Date.now() }
      otherBuckets.set(ip, bucket)
      evictIfFull()
    } else {
      // Refresh position in LRU order.
      otherBuckets.delete(ip)
      otherBuckets.set(ip, bucket)
    }
    const { ok, retryAfterMs } = refillAndTake(bucket, OTHER_CAP, OTHER_REFILL)
    if (!ok) {
      send429(res, retryAfterMs)
      return
    }
    next()
  }
}

/** Test-only hook: resets all buckets so each scenario starts full. */
export function __resetRateLimit(): void {
  anthropicBucket.tokens = ANTHROPIC_CAP
  anthropicBucket.lastRefill = Date.now()
  otherBuckets.clear()
}
