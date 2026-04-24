import Database from 'better-sqlite3'
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3'

import { DEFAULT_TRIGRAM_THRESHOLD, similarity, tokenize } from './trigram.js'
import { DataTableSearchResultRow } from '../types/data-table.types.js'
import { GeographySearchResultRow } from '../types/geography.types.js'
import { SummaryLevelRow } from '../types/summary-level.types.js'

export interface SummaryLevelMatch {
  code: string
  name: string
}

export interface SearchDataTablesParams {
  data_table_id?: string | null
  label_query?: string | null
  api_endpoint?: string | null
  limit?: number
}

export interface MetadataService {
  healthCheck(): Promise<boolean>
  getSummaryLevels(): Promise<SummaryLevelRow[]>
  searchSummaryLevels(
    query: string,
    limit?: number,
  ): Promise<SummaryLevelMatch[]>
  searchGeographies(
    query: string,
    limit?: number,
  ): Promise<GeographySearchResultRow[]>
  searchGeographiesBySummaryLevel(
    query: string,
    summaryLevelCode: string,
    limit?: number,
  ): Promise<GeographySearchResultRow[]>
  searchDataTables(
    params: SearchDataTablesParams,
  ): Promise<DataTableSearchResultRow[]>
  close?(): void | Promise<void>
}

// --- SQLite adapter -------------------------------------------------------
// Read-only. Does candidate prefiltering with LIKE + token-OR and then ranks
// with the JS trigram port so results match the pg_trgm behavior.

interface SqliteSummaryLevelRow {
  id: number
  name: string
  description: string | null
  get_variable: string
  query_name: string
  on_spine: number
  code: string
  parent_summary_level: string | null
  parent_summary_level_id: number | null
  hierarchy_level: number | null
}

interface SqliteGeographyRow {
  id: number
  name: string
  summary_level_code: string | null
  summary_level_name: string | null
  hierarchy_level: number | null
  latitude: number | null
  longitude: number | null
  for_param: string
  in_param: string | null
}

interface SqliteDataTableRow {
  dt_id: number
  data_table_id: string
  label: string
  dataset_label: string
  api_endpoint: string
  component_api_endpoint: string | null
  component_label: string | null
  program_label: string | null
  year: number | null
}

export class SqliteMetadataService implements MetadataService {
  private readonly db: SqliteDatabase
  private stmtSummaryLevels?: Statement<[], SqliteSummaryLevelRow>
  private stmtAllSummaryLevels?: Statement<[], SqliteSummaryLevelRow>
  private stmtGeographiesByLevel?: Statement<[string], SqliteGeographyRow>
  private stmtAllGeographies?: Statement<[], SqliteGeographyRow>

  constructor(path: string) {
    // `readonly: true` is the access guarantee; `journal_mode` / `query_only`
    // pragmas were write-mode micro-opts that fail when the containing
    // directory isn't writable (e.g. a read-only container volume).
    this.db = new Database(path, { readonly: true, fileMustExist: true })
  }

  async healthCheck(): Promise<boolean> {
    try {
      const row = this.db.prepare('SELECT 1 AS health').get() as
        | { health: number }
        | undefined
      return row?.health === 1
    } catch (err) {
      console.error('SqliteMetadataService healthCheck failed:', err)
      return false
    }
  }

  private coerceSummaryLevel(row: SqliteSummaryLevelRow): SummaryLevelRow {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      get_variable: row.get_variable,
      query_name: row.query_name,
      on_spine: Boolean(row.on_spine),
      code: row.code,
      parent_summary_level: row.parent_summary_level,
      parent_geography_level_id: row.parent_summary_level_id,
    } as SummaryLevelRow
  }

  async getSummaryLevels(): Promise<SummaryLevelRow[]> {
    this.stmtAllSummaryLevels ??= this.db.prepare<[], SqliteSummaryLevelRow>(
      `SELECT id, name, description, get_variable, query_name, on_spine, code,
              parent_summary_level, parent_summary_level_id, hierarchy_level
       FROM summary_levels
       ORDER BY code`,
    )
    return this.stmtAllSummaryLevels
      .all()
      .map((r) => this.coerceSummaryLevel(r))
  }

  async searchSummaryLevels(
    query: string,
    limit = 1,
  ): Promise<SummaryLevelMatch[]> {
    const padded = query.trim().padStart(3, '0')
    const normalized = query.trim().toLowerCase()
    this.stmtSummaryLevels ??= this.db.prepare<[], SqliteSummaryLevelRow>(
      `SELECT id, name, description, get_variable, query_name, on_spine, code,
              parent_summary_level, parent_summary_level_id, hierarchy_level
       FROM summary_levels`,
    )
    const rows = this.stmtSummaryLevels.all()

    const scored = rows.map((row) => {
      let score: number
      let rank: number
      if (row.code === padded) {
        score = 1
        rank = 1
      } else if (row.name.toLowerCase() === normalized) {
        score = 1
        rank = 2
      } else {
        score = similarity(row.name.toLowerCase(), normalized)
        rank = 3
      }
      return { row, score, rank }
    })

    const filtered = scored.filter(
      (s) => s.rank < 3 || s.score > DEFAULT_TRIGRAM_THRESHOLD,
    )
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.rank - b.rank
    })

    return filtered.slice(0, Math.max(limit, 1)).map(({ row }) => ({
      code: row.code,
      name: row.name,
    }))
  }

  async searchGeographies(
    query: string,
    limit = 10,
  ): Promise<GeographySearchResultRow[]> {
    const candidates = this.fetchGeographyCandidates(query)
    return this.rankGeographies(candidates, query, limit, true)
  }

  async searchGeographiesBySummaryLevel(
    query: string,
    summaryLevelCode: string,
    limit = 10,
  ): Promise<GeographySearchResultRow[]> {
    this.stmtGeographiesByLevel ??= this.db.prepare<
      [string],
      SqliteGeographyRow
    >(
      `SELECT g.id, g.name, g.summary_level_code, g.latitude, g.longitude, g.for_param, g.in_param,
              sl.name AS summary_level_name, sl.hierarchy_level
       FROM geographies g
       LEFT JOIN summary_levels sl ON sl.code = g.summary_level_code
       WHERE g.summary_level_code = ?`,
    )
    const rows = this.stmtGeographiesByLevel.all(summaryLevelCode)
    return this.rankGeographies(rows, query, limit, false)
  }

  private fetchGeographyCandidates(query: string): SqliteGeographyRow[] {
    const tokens = tokenize(query)
    const byId = new Map<number, SqliteGeographyRow>()

    if (tokens.length > 0) {
      const clauses = tokens.map(() => 'lower(g.name) LIKE ?').join(' OR ')
      const params = tokens.map((t) => `%${t}%`)
      const stmt = this.db.prepare<unknown[], SqliteGeographyRow>(
        `SELECT g.id, g.name, g.summary_level_code, g.latitude, g.longitude, g.for_param, g.in_param,
                sl.name AS summary_level_name, sl.hierarchy_level
         FROM geographies g
         LEFT JOIN summary_levels sl ON sl.code = g.summary_level_code
         WHERE ${clauses}`,
      )
      for (const row of stmt.all(...params)) byId.set(row.id, row)
    }

    // Fallback ILIKE against the full query string, matching the PG behavior.
    const likeStmt = this.db.prepare<[string], SqliteGeographyRow>(
      `SELECT g.id, g.name, g.summary_level_code, g.latitude, g.longitude, g.for_param, g.in_param,
              sl.name AS summary_level_name, sl.hierarchy_level
       FROM geographies g
       LEFT JOIN summary_levels sl ON sl.code = g.summary_level_code
       WHERE lower(g.name) LIKE ?`,
    )
    for (const row of likeStmt.all(`%${query.toLowerCase()}%`))
      byId.set(row.id, row)

    if (byId.size === 0) {
      this.stmtAllGeographies ??= this.db.prepare<[], SqliteGeographyRow>(
        `SELECT g.id, g.name, g.summary_level_code, g.latitude, g.longitude, g.for_param, g.in_param,
                sl.name AS summary_level_name, sl.hierarchy_level
         FROM geographies g
         LEFT JOIN summary_levels sl ON sl.code = g.summary_level_code`,
      )
      for (const row of this.stmtAllGeographies.all()) byId.set(row.id, row)
    }

    return Array.from(byId.values())
  }

  private rankGeographies(
    rows: SqliteGeographyRow[],
    query: string,
    limit: number,
    weighted: boolean,
  ): GeographySearchResultRow[] {
    const scored = rows
      .map((row) => {
        const sim = similarity(row.name, query)
        const lowerName = row.name.toLowerCase()
        const lowerQuery = query.toLowerCase()
        const matchedLike = lowerName.includes(lowerQuery)
        if (sim < DEFAULT_TRIGRAM_THRESHOLD && !matchedLike) return null
        const hierarchy = row.hierarchy_level ?? 99
        const weightedScore = weighted ? sim + (1 - hierarchy / 100) : sim
        return { row, sim, weightedScore }
      })
      .filter(
        (
          s,
        ): s is {
          row: SqliteGeographyRow
          sim: number
          weightedScore: number
        } => s !== null,
      )

    scored.sort((a, b) => {
      if (b.weightedScore !== a.weightedScore)
        return b.weightedScore - a.weightedScore
      if (a.row.name.length !== b.row.name.length)
        return a.row.name.length - b.row.name.length
      return a.row.name.localeCompare(b.row.name)
    })

    return scored.slice(0, limit).map(({ row, sim, weightedScore }) => ({
      id: row.id,
      name: row.name,
      summary_level_name: row.summary_level_name ?? '',
      latitude: row.latitude ?? 0,
      longitude: row.longitude ?? 0,
      for_param: row.for_param,
      in_param: row.in_param ?? '',
      weighted_score: weighted ? weightedScore : sim,
    }))
  }

  async searchDataTables(
    params: SearchDataTablesParams,
  ): Promise<DataTableSearchResultRow[]> {
    const {
      data_table_id = null,
      label_query = null,
      api_endpoint = null,
      limit = 20,
    } = params

    const clauses: string[] = []
    const values: unknown[] = []
    if (data_table_id) {
      clauses.push('(dt.data_table_id = ? OR dt.data_table_id LIKE ?)')
      values.push(data_table_id, `${data_table_id}%`)
    }
    if (api_endpoint) {
      clauses.push(
        '(c.api_endpoint = ? OR c.api_endpoint LIKE ? OR ? LIKE c.api_endpoint || ?' +
          ' OR (c.api_endpoint IS NULL AND (d.api_endpoint = ? OR d.api_endpoint LIKE ? OR ? LIKE d.api_endpoint || ?)))',
      )
      values.push(
        api_endpoint,
        `${api_endpoint}/%`,
        api_endpoint,
        '/%',
        api_endpoint,
        `${api_endpoint}/%`,
        api_endpoint,
        '/%',
      )
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const stmt = this.db.prepare<unknown[], SqliteDataTableRow>(
      `SELECT dt.id AS dt_id, dt.data_table_id, dt.label, dtd.label AS dataset_label,
              d.api_endpoint, c.api_endpoint AS component_api_endpoint,
              c.label AS component_label, p.label AS program_label, y.year
       FROM data_tables dt
       JOIN data_table_datasets dtd ON dtd.data_table_id = dt.id
       JOIN datasets d ON d.id = dtd.dataset_id
       LEFT JOIN components c ON c.id = d.component_id
       LEFT JOIN programs p ON p.id = c.program_id
       LEFT JOIN years y ON y.id = d.year_id
       ${where}`,
    )
    const rows = stmt.all(...values)

    type Aggregated = {
      dataTableId: string
      label: string
      component: string
      datasets: Record<string, Set<string>>
      labelScore: number
    }
    const byId = new Map<string, Aggregated>()

    for (const row of rows) {
      if (label_query) {
        const labelSim = similarity(row.label, label_query)
        const datasetLabelSim = row.dataset_label
          ? similarity(row.dataset_label, label_query)
          : 0
        const best = Math.max(labelSim, datasetLabelSim)
        if (best < DEFAULT_TRIGRAM_THRESHOLD) continue
        const existing = byId.get(row.data_table_id)
        if (existing) {
          if (best > existing.labelScore) existing.labelScore = best
        } else {
          byId.set(row.data_table_id, {
            dataTableId: row.data_table_id,
            label: row.label,
            component: this.formatComponent(row),
            datasets: {},
            labelScore: best,
          })
        }
      } else {
        if (!byId.has(row.data_table_id)) {
          byId.set(row.data_table_id, {
            dataTableId: row.data_table_id,
            label: row.label,
            component: this.formatComponent(row),
            datasets: {},
            labelScore: 0,
          })
        }
      }

      const entry = byId.get(row.data_table_id)
      if (!entry) continue
      const yearKey = row.year == null ? 'unknown' : String(row.year)
      const set = entry.datasets[yearKey] ?? new Set<string>()
      set.add(row.api_endpoint)
      entry.datasets[yearKey] = set
    }

    const aggregated = Array.from(byId.values())
    aggregated.sort((a, b) => {
      if (label_query) {
        if (b.labelScore !== a.labelScore) return b.labelScore - a.labelScore
      }
      return a.dataTableId.localeCompare(b.dataTableId)
    })

    return aggregated.slice(0, limit).map((entry) => {
      const datasets: Record<string, string[]> = {}
      for (const [year, set] of Object.entries(entry.datasets)) {
        datasets[year] = Array.from(set).sort()
      }
      return {
        data_table_id: entry.dataTableId,
        label: entry.label,
        component: entry.component,
        datasets,
      }
    })
  }

  private formatComponent(row: SqliteDataTableRow): string {
    if (row.program_label && row.component_label) {
      return `${row.program_label} - ${row.component_label}`
    }
    return row.component_api_endpoint ?? row.api_endpoint
  }

  close(): void {
    this.db.close()
  }
}

// --- Singleton accessor ---------------------------------------------------
// http.ts hard-pins a SqliteMetadataService via setMetadataService() before
// any tool is constructed. Tests call setMetadataService() with a mock.
// There is no env-driven fallback — the caller must register one.

let cached: MetadataService | undefined

export function getMetadataService(): MetadataService {
  if (!cached) {
    throw new Error(
      'No MetadataService registered. Call setMetadataService() from the entrypoint before constructing any tool.',
    )
  }
  return cached
}

export function setMetadataService(service: MetadataService): void {
  cached = service
}

export function resetMetadataService(): void {
  cached = undefined
}
