import { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { BaseTool } from './base.tool.js'
import { buildCitation } from '../helpers/citation.js'
import { censusFetch } from '../services/census-api.service.js'
import {
  FetchAggregateDataToolSchema,
  TableArgs,
  TableSchema,
} from '../schema/fetch-aggregate-data.schema.js'
import { ToolContent } from '../types/base.types.js'

import {
  datasetValidator,
  validateGeographyArgs,
} from '../schema/validators.js'

export const toolDescription = `
  Fetches statistical data from U.S. Census Bureau datasets including population, demographics, income, housing, employment, and economic indicators. Use this tool when users request Census statistics, demographic breakdowns, or socioeconomic data for specific geographic areas. Requires a dataset identifier, year/vintage, geographic scope (state, county, tract, etc.), and specific variables or table groups. Returns structured data with proper citations for authoritative government statistics.
`

export class FetchAggregateDataTool extends BaseTool<TableArgs> {
  name = 'fetch-aggregate-data'
  description = toolDescription
  inputSchema: Tool['inputSchema'] = TableSchema as Tool['inputSchema']
  readonly requiresApiKey = true

  annotations = {
    title: 'Fetch Census aggregate data',
    readOnlyHint: true,
    openWorldHint: true,
  }

  get argsSchema() {
    return FetchAggregateDataToolSchema.superRefine((args, ctx) => {
      //Check that the correct tool is used to fetch data
      const identifiedDataset = datasetValidator(args.dataset)

      if (identifiedDataset.tool !== this.name) {
        ctx.addIssue({
          path: ['dataset'],
          code: z.ZodIssueCode.custom,
          message: identifiedDataset.message,
        })
      }

      validateGeographyArgs(args, ctx)
    })
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  validateArgs(input: unknown) {
    return this.argsSchema.safeParse(input)
  }

  async toolHandler(
    args: TableArgs,
    apiKey: string,
  ): Promise<{ content: ToolContent[] }> {
    try {
      // censusFetch returns the URL with the API key already redacted so we
      // never emit the plaintext key to logs or responses.
      const { url, headers, rows } = await censusFetch(args, apiKey)
      console.log(`URL Attempted: ${url}`)

      const output = rows
        .map((row) => headers.map((h, i) => `${h}: ${row[i]}`).join(', '))
        .join('\n')

      return this.createSuccessResponse(
        `Response from ${args.dataset}:\n${output}\n${buildCitation(url)}`,
      )
    } catch (err) {
      return this.createErrorResponse(`Fetch failed: ${(err as Error).message}`)
    }
  }
}
