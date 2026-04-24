// Port of PostgreSQL pg_trgm similarity for the SQLite backend.
//
// pg_trgm lowercases, replaces non-alphanumerics with spaces, splits into
// words, and emits trigrams with a two-space prefix and single-space suffix
// per word. Similarity is |intersection| / |union| over the multiset-free
// trigram sets; the `%` operator triggers at threshold 0.3 (pg_trgm default).

const PAD_PREFIX = '  '
const PAD_SUFFIX = ' '
export const DEFAULT_TRIGRAM_THRESHOLD = 0.3

export function trigrams(input: string): Set<string> {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const grams = new Set<string>()
  if (!normalized) return grams
  for (const word of normalized.split(/\s+/)) {
    if (!word) continue
    const padded = PAD_PREFIX + word + PAD_SUFFIX
    for (let i = 0; i <= padded.length - 3; i++) {
      grams.add(padded.slice(i, i + 3))
    }
  }
  return grams
}

export function similarity(a: string, b: string): number {
  const g1 = trigrams(a)
  const g2 = trigrams(b)
  if (g1.size === 0 || g2.size === 0) return 0
  let intersection = 0
  for (const g of g1) if (g2.has(g)) intersection++
  const union = g1.size + g2.size - intersection
  return union === 0 ? 0 : intersection / union
}

export function matches(
  a: string,
  b: string,
  threshold = DEFAULT_TRIGRAM_THRESHOLD,
): boolean {
  return similarity(a, b) >= threshold
}

// Extracts meaningful prefiltering tokens (>=2 chars after normalization) so the
// SQLite candidate scan stays bounded before JS similarity ranking.
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}
