#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import Database from 'better-sqlite3'

interface SummaryLevelFixture {
  get_variable: string
  query_name: string
  name: string
  code: string
  parent_summary_level: string | null
  on_spine: boolean
  description: string
}

interface ComponentFixtureRow {
  COMPONENT_STRING: string
  COMPONENT_LABEL: string
  COMPONENT_DESCRIPTION: string
  API_SHORT_NAME: string
  PROGRAM_STRING: string
  PROGRAM_LABEL: string
}

interface SampleGeography {
  name: string
  summary_level_code: string
  for_param: string
  in_param: string | null
  latitude: number
  longitude: number
}

interface SampleDataTable {
  data_table_id: string
  label: string
  datasets: Array<{
    api_endpoint: string
    component: string
    year: number
    label?: string
  }>
}

function parseArgs(argv: string[]): { fixture: boolean; output: string } {
  let fixture = false
  let output = './census-metadata.sqlite'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fixture') fixture = true
    else if (arg === '--out' || arg === '-o') output = argv[++i]
  }
  return { fixture, output: resolve(output) }
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = []
  const lines = splitCsvLines(text)
  if (lines.length === 0) return rows
  const header = parseCsvLine(lines[0])
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const cells = parseCsvLine(line)
    const row: Record<string, string> = {}
    header.forEach((h, idx) => {
      row[h] = cells[idx] ?? ''
    })
    rows.push(row)
  }
  return rows
}

function splitCsvLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current)
      current = ''
    } else if (ch === '\r' && !inQuotes) {
      // Skip
    } else {
      current += ch
    }
  }
  if (current) lines.push(current)
  return lines
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE summary_levels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      get_variable TEXT NOT NULL,
      query_name TEXT NOT NULL,
      on_spine INTEGER NOT NULL,
      code TEXT NOT NULL UNIQUE,
      parent_summary_level TEXT,
      parent_summary_level_id INTEGER,
      hierarchy_level INTEGER DEFAULT 99
    );
    CREATE INDEX idx_summary_levels_code ON summary_levels(code);

    CREATE TABLE geographies (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      summary_level_code TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      for_param TEXT NOT NULL,
      in_param TEXT
    );
    CREATE INDEX idx_geographies_summary_level ON geographies(summary_level_code);
    CREATE INDEX idx_geographies_name ON geographies(lower(name));

    CREATE TABLE programs (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      acronym TEXT NOT NULL UNIQUE,
      description TEXT
    );

    CREATE TABLE components (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      component_id TEXT NOT NULL UNIQUE,
      api_endpoint TEXT NOT NULL,
      description TEXT,
      program_id INTEGER NOT NULL REFERENCES programs(id)
    );
    CREATE INDEX idx_components_api_endpoint ON components(api_endpoint);

    CREATE TABLE years (
      id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE datasets (
      id INTEGER PRIMARY KEY,
      api_endpoint TEXT NOT NULL,
      year_id INTEGER REFERENCES years(id),
      component_id INTEGER REFERENCES components(id)
    );
    CREATE INDEX idx_datasets_api_endpoint ON datasets(api_endpoint);

    CREATE TABLE data_tables (
      id INTEGER PRIMARY KEY,
      data_table_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    );
    CREATE INDEX idx_data_tables_data_table_id ON data_tables(data_table_id);

    CREATE TABLE data_table_datasets (
      id INTEGER PRIMARY KEY,
      data_table_id INTEGER NOT NULL REFERENCES data_tables(id),
      dataset_id INTEGER NOT NULL REFERENCES datasets(id),
      label TEXT NOT NULL,
      UNIQUE (data_table_id, dataset_id)
    );
  `)
}

function hierarchyLevel(
  code: string,
  parentMap: Map<string, string | null>,
): number {
  let depth = 0
  let cursor: string | null = code
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    cursor = parentMap.get(cursor) ?? null
    if (cursor) depth += 1
  }
  return depth * 10
}

function seedSummaryLevels(
  db: Database.Database,
  rows: SummaryLevelFixture[],
): void {
  const parentMap = new Map<string, string | null>()
  for (const row of rows) parentMap.set(row.code, row.parent_summary_level)

  const insert = db.prepare(
    `INSERT INTO summary_levels
       (name, description, get_variable, query_name, on_spine, code, parent_summary_level, hierarchy_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const linkParent = db.prepare(
    `UPDATE summary_levels
        SET parent_summary_level_id = (SELECT id FROM summary_levels WHERE code = ?)
      WHERE code = ?`,
  )
  const tx = db.transaction((items: SummaryLevelFixture[]) => {
    for (const row of items) {
      insert.run(
        row.name,
        row.description,
        row.get_variable,
        row.query_name,
        row.on_spine ? 1 : 0,
        row.code,
        row.parent_summary_level,
        hierarchyLevel(row.code, parentMap),
      )
    }
    for (const row of items) {
      if (row.parent_summary_level)
        linkParent.run(row.parent_summary_level, row.code)
    }
  })
  tx(rows)
}

function seedProgramsAndComponents(
  db: Database.Database,
  rows: ComponentFixtureRow[],
): void {
  const programInsert = db.prepare(
    `INSERT OR IGNORE INTO programs (label, acronym) VALUES (?, ?)`,
  )
  const programId = db.prepare(`SELECT id FROM programs WHERE acronym = ?`)
  const componentInsert = db.prepare(
    `INSERT OR IGNORE INTO components
       (label, component_id, api_endpoint, description, program_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((items: ComponentFixtureRow[]) => {
    for (const row of items) {
      programInsert.run(row.PROGRAM_LABEL, row.PROGRAM_STRING)
      const pid = (programId.get(row.PROGRAM_STRING) as { id: number }).id
      componentInsert.run(
        row.COMPONENT_LABEL,
        row.COMPONENT_STRING,
        row.API_SHORT_NAME,
        row.COMPONENT_DESCRIPTION,
        pid,
      )
    }
  })
  tx(rows)
}

function seedSampleGeographies(
  db: Database.Database,
  rows: SampleGeography[],
): void {
  const stmt = db.prepare(
    `INSERT INTO geographies (name, summary_level_code, latitude, longitude, for_param, in_param)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const tx = db.transaction((items: SampleGeography[]) => {
    for (const row of items) {
      stmt.run(
        row.name,
        row.summary_level_code,
        row.latitude,
        row.longitude,
        row.for_param,
        row.in_param,
      )
    }
  })
  tx(rows)
}

function seedSampleDataTables(
  db: Database.Database,
  rows: SampleDataTable[],
): void {
  const componentByEndpoint = db.prepare(
    `SELECT id FROM components WHERE api_endpoint = ?`,
  )
  const yearUpsert = db.prepare(`INSERT OR IGNORE INTO years (year) VALUES (?)`)
  const yearSelect = db.prepare(`SELECT id FROM years WHERE year = ?`)
  const datasetUpsert = db.prepare(
    `INSERT INTO datasets (api_endpoint, year_id, component_id) VALUES (?, ?, ?)`,
  )
  const datasetSelect = db.prepare(
    `SELECT id FROM datasets WHERE api_endpoint = ? AND year_id = ? AND (component_id IS ? OR component_id = ?)`,
  )
  const dataTableUpsert = db.prepare(
    `INSERT OR IGNORE INTO data_tables (data_table_id, label) VALUES (?, ?)`,
  )
  const dataTableSelect = db.prepare(
    `SELECT id FROM data_tables WHERE data_table_id = ?`,
  )
  const linkUpsert = db.prepare(
    `INSERT OR IGNORE INTO data_table_datasets (data_table_id, dataset_id, label) VALUES (?, ?, ?)`,
  )

  const tx = db.transaction((items: SampleDataTable[]) => {
    for (const table of items) {
      dataTableUpsert.run(table.data_table_id, table.label)
      const dtId = (dataTableSelect.get(table.data_table_id) as { id: number })
        .id

      for (const ds of table.datasets) {
        yearUpsert.run(ds.year)
        const yearId = (yearSelect.get(ds.year) as { id: number }).id
        const componentRow = componentByEndpoint.get(ds.api_endpoint) as
          | { id: number }
          | undefined
        const componentId = componentRow?.id ?? null
        let datasetRow = datasetSelect.get(
          ds.api_endpoint,
          yearId,
          componentId,
          componentId,
        ) as { id: number } | undefined
        if (!datasetRow) {
          const result = datasetUpsert.run(ds.api_endpoint, yearId, componentId)
          datasetRow = { id: Number(result.lastInsertRowid) }
        }
        linkUpsert.run(dtId, datasetRow.id, ds.label ?? table.label)
      }
    }
  })
  tx(rows)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function sampleGeographies(): SampleGeography[] {
  return [
    {
      name: 'United States',
      summary_level_code: '010',
      latitude: 39.8283,
      longitude: -98.5795,
      for_param: 'us:1',
      in_param: null,
    },
    {
      name: 'Texas',
      summary_level_code: '040',
      latitude: 31.0545,
      longitude: -97.5635,
      for_param: 'state:48',
      in_param: null,
    },
    {
      name: 'Pennsylvania',
      summary_level_code: '040',
      latitude: 40.5907,
      longitude: -77.2098,
      for_param: 'state:42',
      in_param: null,
    },
    {
      name: 'California',
      summary_level_code: '040',
      latitude: 36.1162,
      longitude: -119.6816,
      for_param: 'state:06',
      in_param: null,
    },
    {
      name: 'New York',
      summary_level_code: '040',
      latitude: 42.1657,
      longitude: -74.9481,
      for_param: 'state:36',
      in_param: null,
    },
    {
      name: 'Travis County, Texas',
      summary_level_code: '050',
      latitude: 30.3358,
      longitude: -97.7821,
      for_param: 'county:453',
      in_param: 'state:48',
    },
    {
      name: 'Harris County, Texas',
      summary_level_code: '050',
      latitude: 29.8574,
      longitude: -95.3927,
      for_param: 'county:201',
      in_param: 'state:48',
    },
    {
      name: 'Los Angeles County, California',
      summary_level_code: '050',
      latitude: 34.3085,
      longitude: -118.2284,
      for_param: 'county:037',
      in_param: 'state:06',
    },
    {
      name: 'Philadelphia County, Pennsylvania',
      summary_level_code: '050',
      latitude: 40.0094,
      longitude: -75.1333,
      for_param: 'county:101',
      in_param: 'state:42',
    },
    {
      name: 'Cook County, Illinois',
      summary_level_code: '050',
      latitude: 41.8401,
      longitude: -87.8168,
      for_param: 'county:031',
      in_param: 'state:17',
    },
    {
      name: 'Austin city, Texas',
      summary_level_code: '160',
      latitude: 30.3074,
      longitude: -97.7559,
      for_param: 'place:05000',
      in_param: 'state:48',
    },
    {
      name: 'Philadelphia city, Pennsylvania',
      summary_level_code: '160',
      latitude: 40.0094,
      longitude: -75.1333,
      for_param: 'place:60000',
      in_param: 'state:42',
    },
    {
      name: 'Los Angeles city, California',
      summary_level_code: '160',
      latitude: 34.0194,
      longitude: -118.4108,
      for_param: 'place:44000',
      in_param: 'state:06',
    },
  ]
}

function sampleDataTables(): SampleDataTable[] {
  const acs5Component = 'acs/acs5'
  const acs1Component = 'acs/acs1'
  return [
    {
      data_table_id: 'B19013',
      label:
        'Median Household Income in the Past 12 Months (in Inflation-Adjusted Dollars)',
      datasets: [
        { api_endpoint: acs5Component, component: 'ACSDT5Y', year: 2022 },
        { api_endpoint: acs5Component, component: 'ACSDT5Y', year: 2021 },
        { api_endpoint: acs1Component, component: 'ACSDT1Y', year: 2022 },
      ],
    },
    {
      data_table_id: 'B01003',
      label: 'Total Population',
      datasets: [
        { api_endpoint: acs5Component, component: 'ACSDT5Y', year: 2022 },
        { api_endpoint: acs1Component, component: 'ACSDT1Y', year: 2022 },
      ],
    },
    {
      data_table_id: 'B25077',
      label: 'Median Value (Dollars) for Owner-Occupied Housing Units',
      datasets: [
        { api_endpoint: acs5Component, component: 'ACSDT5Y', year: 2022 },
      ],
    },
    {
      data_table_id: 'B16005',
      label:
        'Nativity By Language Spoken At Home By Ability To Speak English For The Population 5 Years And Over',
      datasets: [
        { api_endpoint: acs5Component, component: 'ACSDT5Y', year: 2022 },
        { api_endpoint: acs1Component, component: 'ACSDT1Y', year: 2022 },
      ],
    },
    {
      data_table_id: 'B02001',
      label: 'Race',
      datasets: [
        { api_endpoint: acs5Component, component: 'ACSDT5Y', year: 2022 },
        { api_endpoint: acs1Component, component: 'ACSDT1Y', year: 2022 },
      ],
    },
  ]
}

function buildFromFixture(outPath: string, mcpDbDataDir: string): void {
  mkdirSync(dirname(outPath), { recursive: true })
  if (existsSync(outPath)) rmSync(outPath)
  const db = new Database(outPath)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    createSchema(db)

    const summaryLevels = readJson<{ summary_levels: SummaryLevelFixture[] }>(
      resolve(mcpDbDataDir, 'summary_levels.json'),
    ).summary_levels
    seedSummaryLevels(db, summaryLevels)

    const componentsCsv = readFileSync(
      resolve(mcpDbDataDir, 'components-programs.csv'),
      'utf8',
    )
    const components = parseCsv(
      componentsCsv,
    ) as unknown as ComponentFixtureRow[]
    seedProgramsAndComponents(db, components)

    seedSampleGeographies(db, sampleGeographies())
    seedSampleDataTables(db, sampleDataTables())

    db.exec('ANALYZE')
  } finally {
    db.close()
  }
}

function main() {
  const { fixture, output } = parseArgs(process.argv.slice(2))
  const repoRoot = resolve(process.cwd(), '..')
  const mcpDbData = resolve(repoRoot, 'mcp-db', 'data')

  if (!fixture) {
    console.error(
      'Only --fixture mode is implemented in this build. Pass --fixture to seed from mcp-db/data JSON + samples.',
    )
    process.exit(2)
  }

  console.log(`Building SQLite metadata at ${output}`)
  buildFromFixture(output, mcpDbData)
  console.log('Done.')
}

main()
