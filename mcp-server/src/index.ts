import 'dotenv/config'

import { resolve } from 'node:path'
import process from 'node:process'

const enableDebugLogs = process.env.DEBUG_LOGS === 'true'
if (!enableDebugLogs) {
  console.log = () => {}
  console.info = () => {}
  console.warn = () => {}
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { MCPServer } from './server.js'
import {
  SqliteMetadataService,
  setMetadataService,
} from './services/metadata.service.js'
import { FetchAggregateDataTool } from './tools/fetch-aggregate-data.tool.js'
import { FetchDatasetGeographyTool } from './tools/fetch-dataset-geography.tool.js'
import { ListDatasetsTool } from './tools/list-datasets.tool.js'
import { ResolveGeographyFipsTool } from './tools/resolve-geography-fips.tool.js'
import { SearchDataTablesTool } from './tools/search-data-tables.tool.js'
import { PopulationPrompt } from './prompts/population.prompt.js'

const SQLITE_PATH = resolve(
  process.env.SQLITE_PATH ?? './census-metadata.sqlite',
)

async function main() {
  setMetadataService(new SqliteMetadataService(SQLITE_PATH))

  const mcpServer = new MCPServer('census-api', '0.1.0')
  mcpServer.registerPrompt(new PopulationPrompt())
  mcpServer.registerTool(new FetchAggregateDataTool())
  mcpServer.registerTool(new FetchDatasetGeographyTool())
  mcpServer.registerTool(new ListDatasetsTool())
  mcpServer.registerTool(new ResolveGeographyFipsTool())
  mcpServer.registerTool(new SearchDataTablesTool())

  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
