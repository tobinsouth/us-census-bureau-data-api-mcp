import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { buildCitation } from '../helpers/citation.js'
import { censusFetch } from '../services/census-api.service.js'
import {
  FetchAggregateDataToolSchema,
  TableArgs,
} from '../schema/fetch-aggregate-data.schema.js'
import { ToolContent } from '../types/base.types.js'

const VISUALIZE_RESOURCE_URI = 'ui://widgets/visualize.html'
const MAX_PAYLOAD_BYTES = 130 * 1024

// Census "jam values" — sentinel ints the API returns for suppressed /
// unavailable / estimate-not-applicable cells. Normalize them to null.
const JAM_VALUES = new Set<number>([
  -222222222, -333333333, -555555555, -666666666, -888888888, -999999999,
])

const DataRowSchema = z.record(z.string(), z.unknown())

const GeoSchema = z.object({
  // Accept singular or plural — `"state"`/`"county"` are friendlier to write
  // and appear in existing verification harnesses.
  level: z
    .enum(['states', 'counties', 'state', 'county'])
    .describe('TopoJSON granularity'),
  fipsField: z
    .string()
    .optional()
    .describe(
      'Row column to use for FIPS matching. Defaults: counties → state+county stitch, states → state. Usually omitted.',
    ),
})

function normalizeLevel(level: string): 'states' | 'counties' {
  return level === 'state' || level === 'states' ? 'states' : 'counties'
}

const InteractiveSchema = z.object({
  onClickSend: z
    .union([
      z
        .string()
        .describe(
          'Message template sent to the conversation when a region is clicked. Supports {column} placeholders (e.g. "Tell me about {NAME} ({__fips})").',
        ),
      z.object({
        updateContext: z
          .record(z.string(), z.unknown())
          .describe(
            'Sent to updateModelContext instead of as a visible message.',
          ),
      }),
    ])
    .optional(),
})

export const VisualizeCensusInputSchema = z
  .object({
    title: z.string().describe('Title shown above the chart.'),
    note: z
      .string()
      .optional()
      .describe(
        'Short caption rendered as a callout. Use for provenance, caveats, or reasoning.',
      ),
    fetch: FetchAggregateDataToolSchema.optional().describe(
      'Census API request — same shape as fetch-aggregate-data. Omit when providing `data` inline.',
    ),
    data: z
      .array(DataRowSchema)
      .optional()
      .describe(
        'Pre-fetched rows (array of {column: value} objects). Omit when providing `fetch`.',
      ),
    spec: z
      .record(z.string(), z.unknown())
      .describe(
        'Vega-Lite spec. Do NOT include `data`/`datasets`; the widget wires the dataset in. For choropleths use mark:"geoshape" and set `geo`.',
      ),
    geo: GeoSchema.optional(),
    interactive: InteractiveSchema.optional(),
  })
  .refine(
    (args) => Boolean(args.fetch) !== Boolean(args.data),
    'Provide exactly one of `fetch` or `data`.',
  )

export type VisualizeCensusArgs = z.infer<typeof VisualizeCensusInputSchema>

const VisualizeCensusJsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    note: { type: 'string' },
    fetch: {
      type: 'object',
      description:
        'Census API request, same shape as fetch-aggregate-data. Either this or `data` must be set.',
    },
    data: {
      type: 'array',
      description:
        'Pre-fetched rows (array of objects). Omit when using `fetch`.',
      items: { type: 'object' },
    },
    spec: {
      type: 'object',
      description:
        'Vega-Lite spec. Omit `data`/`datasets`; the widget wires the normalized rows.',
    },
    geo: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['states', 'counties', 'state', 'county'],
        },
        fipsField: { type: 'string' },
      },
      required: ['level'],
    },
    interactive: {
      type: 'object',
      properties: {
        onClickSend: {
          description:
            'Template string (e.g. "Tell me about {NAME}") OR {updateContext: {...}}.',
        },
      },
    },
  },
  required: ['title', 'spec'],
} as const

export const visualizeCensusDescription = `
  Render an interactive Vega-Lite chart of Census data. Use this when the user would benefit from seeing data spatially or graphically (maps, trends, distributions) rather than reading a table. The model authors the Vega-Lite spec; the widget renders it.

  Pass either \`fetch\` (same shape as fetch-aggregate-data — runs the query) OR \`data\` (pre-fetched rows). Omit \`data\`/\`datasets\` from your \`spec\` — the widget injects the dataset.

  For choropleths, set \`mark: "geoshape"\` and \`geo: {level: "states" | "counties"}\`. The widget fetches TopoJSON and auto-scopes to the queried region (e.g. one Texas county query → only that county is drawn, not all 3000+).

  The response \`note\` field is shown as an inline callout — use it to convey caveats or your reasoning (why this chart vs. another).
`

export class VisualizeCensusTool extends BaseTool<VisualizeCensusArgs> {
  name = 'visualize-census'
  description = visualizeCensusDescription
  readonly requiresApiKey = true

  inputSchema: Tool['inputSchema'] =
    VisualizeCensusJsonSchema as unknown as Tool['inputSchema']

  annotations = {
    title: 'Visualize Census data',
    readOnlyHint: true,
    openWorldHint: true,
  }

  _meta = {
    ui: { resourceUri: VISUALIZE_RESOURCE_URI },
  }

  get argsSchema() {
    return VisualizeCensusInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  async toolHandler(
    args: VisualizeCensusArgs,
    apiKey?: string,
  ): Promise<{ content: ToolContent[] }> {
    try {
      const { rows: rawRows, sourceUrl } = await this.loadRows(args, apiKey)
      const normalizedGeo = args.geo
        ? {
            level: normalizeLevel(args.geo.level),
            fipsField: args.geo.fipsField,
          }
        : undefined
      const normalized = normalizeRows(rawRows, normalizedGeo)
      const strippedSpec = stripDatasetFromSpec(args.spec)
      const truncation = maybePruneRows(
        normalized,
        strippedSpec,
        normalizedGeo ? { dropNameForGeo: true } : { dropNameForGeo: false },
      )

      const payload = {
        title: args.title,
        ...(args.note ? { note: args.note } : {}),
        spec: strippedSpec,
        rows: truncation.rows,
        ...(normalizedGeo ? { geo: normalizedGeo } : {}),
        ...(args.interactive ? { interactive: args.interactive } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        // `truncated` signals dropped ROWS; column pruning is reported
        // separately so downstream diagnostics can distinguish the two.
        truncated: null as { droppedRows: number } | null,
        ...(truncation.prunedColumns
          ? { prunedColumns: truncation.prunedColumns }
          : {}),
      }

      const payloadJson = JSON.stringify(payload)
      const summary = buildTextSummary(payload, truncation.bytes)

      return {
        content: [
          { type: 'text' as const, text: payloadJson },
          { type: 'text' as const, text: summary },
        ],
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      return this.createErrorResponse(
        `Failed to prepare visualization: ${message}`,
      )
    }
  }

  private async loadRows(
    args: VisualizeCensusArgs,
    apiKey?: string,
  ): Promise<{ rows: Record<string, unknown>[]; sourceUrl?: string }> {
    if (args.data) {
      return { rows: args.data as Record<string, unknown>[] }
    }
    if (!args.fetch) {
      throw new Error('Provide exactly one of `fetch` or `data`.')
    }
    if (!apiKey) {
      throw new Error('CENSUS_API_KEY is not set.')
    }
    const fetchArgs = args.fetch as TableArgs
    const {
      url: sourceUrl,
      headers,
      rows,
    } = await censusFetch(fetchArgs, apiKey)
    const objects = rows.map((row) => {
      const obj: Record<string, unknown> = {}
      headers.forEach((h, i) => {
        obj[h] = row[i]
      })
      return obj
    })
    return { rows: objects, sourceUrl }
  }
}

function buildTextSummary(
  payload: {
    title: string
    rows: Record<string, unknown>[]
    spec: Record<string, unknown>
  },
  bytes: number,
): string {
  const rows = payload.rows.length
  const mark = readMark(payload.spec)
  const prefix = `Census visualization: ${payload.title}. ${rows} row${rows === 1 ? '' : 's'}${mark ? `, mark=${mark}` : ''}, payload=${Math.round(bytes / 1024)}KB.`
  return buildCitation(prefix)
}

function readMark(spec: Record<string, unknown>): string | null {
  const mark = spec.mark
  if (typeof mark === 'string') return mark
  if (mark && typeof mark === 'object' && 'type' in mark) {
    const t = (mark as { type?: unknown }).type
    return typeof t === 'string' ? t : null
  }
  return null
}

function stripDatasetFromSpec(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  // Shallow clone, drop top-level data/datasets. The widget injects rows.
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(spec)) {
    if (k === 'data' || k === 'datasets') continue
    out[k] = v
  }
  return out
}

function coerceValue(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw === 'number') {
    return JAM_VALUES.has(raw) ? null : raw
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isNaN(n)) {
        return JAM_VALUES.has(n) ? null : n
      }
    }
    return raw
  }
  return raw
}

function digits(value: unknown): string {
  if (value == null) return ''
  return String(value).replace(/\D/g, '')
}

function deriveFips(
  row: Record<string, unknown>,
  level: 'states' | 'counties' | undefined,
  fipsField?: string,
): string | null {
  if (!level) return null
  const expected = level === 'counties' ? 5 : 2

  // Caller-designated field wins. Shape-detect *within* the value: if it's
  // already ≥ expected width, it's the final composite — slice-and-pad. If
  // it's shorter, treat it as a component (pad for states; fall through to
  // the stitch path for counties).
  if (fipsField) {
    const d = digits(row[fipsField])
    if (d.length >= expected) return d.slice(-expected).padStart(expected, '0')
    if (level === 'states' && d.length > 0) return d.padStart(expected, '0')
    // counties + short value → fall through to stitch
  }

  const candidates =
    level === 'counties'
      ? [
          row.GEO_ID,
          row.ucgid_code,
          row.county_fips,
          row.fips,
          row.FIPS,
          row.county,
          row.COUNTY,
        ]
      : [
          row.GEO_ID,
          row.ucgid_code,
          row.state_fips,
          row.fips,
          row.FIPS,
          row.state,
          row.STATE,
        ]
  for (const candidate of candidates) {
    const d = digits(candidate)
    if (d.length >= expected) return d.slice(-expected).padStart(expected, '0')
  }

  if (level === 'states') {
    // Any short state digit we saw above deserves padding rather than null.
    const d = digits(row.state ?? row.STATE)
    return d ? d.padStart(2, '0') : null
  }

  // counties compose from parts (state+county).
  const state = digits(row.state ?? row.STATE)
    .padStart(2, '0')
    .slice(-2)
  const county = digits(row.county ?? row.COUNTY)
    .padStart(3, '0')
    .slice(-3)
  if (
    state.length === 2 &&
    county.length === 3 &&
    (state !== '00' || county !== '000')
  ) {
    return state + county
  }
  return null
}

function normalizeRows(
  rows: Record<string, unknown>[],
  geo?: { level: 'states' | 'counties'; fipsField?: string },
): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = coerceValue(value)
    }
    if (geo) {
      const fips = deriveFips(normalized, geo.level, geo.fipsField)
      if (fips != null) normalized.__fips = fips
    }
    return normalized
  })
}

interface PruneResult {
  rows: Record<string, unknown>[]
  bytes: number
  prunedColumns?: string[]
}

function maybePruneRows(
  rows: Record<string, unknown>[],
  spec: Record<string, unknown>,
  opts: { dropNameForGeo: boolean },
): PruneResult {
  const initialJson = JSON.stringify(rows)
  const initialBytes = Buffer.byteLength(initialJson, 'utf8')
  if (initialBytes <= MAX_PAYLOAD_BYTES) {
    return { rows, bytes: initialBytes }
  }

  const referenced = collectReferencedColumns(spec)
  if (!rows.length) return { rows, bytes: initialBytes }
  const actual = new Set(Object.keys(rows[0]))

  // Always preserve __fips for geo lookups.
  referenced.add('__fips')

  const keep = new Set<string>()
  for (const col of referenced) {
    if (actual.has(col)) keep.add(col)
  }

  // If nothing matched, keep everything except NAME (for geo) rather than
  // dropping the whole payload — better to overflow slightly than to ship an
  // empty chart.
  const dropColumns: string[] = []
  if (keep.size === 0) {
    for (const col of actual) keep.add(col)
  }
  if (opts.dropNameForGeo && keep.has('NAME')) {
    keep.delete('NAME')
    dropColumns.push('NAME')
  }
  for (const col of actual) {
    if (!keep.has(col) && !dropColumns.includes(col)) dropColumns.push(col)
  }

  const pruned = rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const k of keep) {
      if (k in row) out[k] = row[k]
    }
    return out
  })
  const bytes = Buffer.byteLength(JSON.stringify(pruned), 'utf8')
  return { rows: pruned, bytes, prunedColumns: dropColumns }
}

function collectReferencedColumns(spec: unknown): Set<string> {
  const out = new Set<string>()
  // `datum.X`, `datum['X']`, `datum["X"]` — all three shapes appear in
  // model-authored expressions depending on whether the column name is a
  // valid JS identifier. Miss any of them and the corresponding column gets
  // pruned out, producing NaN on render.
  const datumRef =
    /\bdatum(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[['"]([^'"]+)['"]\])/g

  const walk = (node: unknown) => {
    if (!node) return
    if (typeof node === 'string') {
      let match
      while ((match = datumRef.exec(node))) {
        const name = match[1] ?? match[2]
        if (name) out.add(name)
      }
      return
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v)
      return
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'field' && typeof v === 'string') {
          out.add(v)
        } else if (k === 'lookup' && typeof v === 'string') {
          out.add(v)
        } else if (k === 'as') {
          if (typeof v === 'string') out.add(v)
          if (Array.isArray(v))
            for (const s of v) if (typeof s === 'string') out.add(s)
        }
        walk(v)
      }
    }
  }
  walk(spec)
  return out
}
