import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { ToolContent } from '../types/base.types.js'

const here = dirname(fileURLToPath(import.meta.url))
const mcpServerRoot = resolve(here, '..', '..')

const LEVEL_TO_PATH: Record<string, string> = {
  states: 'node_modules/us-atlas/states-10m.json',
  counties: 'node_modules/us-atlas/counties-10m.json',
}

const cache = new Map<string, string>()

function loadTopoJson(level: string): string {
  const cached = cache.get(level)
  if (cached) return cached
  const relPath = LEVEL_TO_PATH[level]
  if (!relPath) throw new Error(`Unknown TopoJSON level: ${level}`)
  const text = readFileSync(resolve(mcpServerRoot, relPath), 'utf8')
  cache.set(level, text)
  return text
}

export const GetTopoJsonInputSchema = z.object({
  level: z.enum(['states', 'counties']),
})

export type GetTopoJsonArgs = z.infer<typeof GetTopoJsonInputSchema>

export class GetTopoJsonTool extends BaseTool<GetTopoJsonArgs> {
  name = 'get-topojson'
  description =
    'Returns us-atlas TopoJSON for state or county boundaries. Internal — called by the visualize-census widget, not by the model.'
  readonly requiresApiKey = false

  inputSchema: Tool['inputSchema'] = {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['states', 'counties'] },
    },
    required: ['level'],
  }

  annotations = {
    title: 'US TopoJSON boundaries',
    readOnlyHint: true,
    openWorldHint: false,
  }

  _meta = {
    ui: { visibility: ['app'] },
  }

  get argsSchema() {
    return GetTopoJsonInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  async toolHandler(
    args: GetTopoJsonArgs,
  ): Promise<{ content: ToolContent[] }> {
    try {
      const text = loadTopoJson(args.level)
      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      return this.createErrorResponse(`Failed to load TopoJSON: ${message}`)
    }
  }
}
