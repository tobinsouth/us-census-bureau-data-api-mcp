import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MCPPrompt, PromptRegistry } from './prompts/base.prompt.js'
import { MCPResource, ResourceRegistry } from './resources/base.resource.js'
import { MCPTool, ToolRegistry } from './tools/base.tool.js'

// Tools may be hidden from the model via _meta.ui.visibility: ['app'].
// We still let the app call them via tools/call — they just don't appear in
// tools/list for normal clients.
function isModelVisible(tool: { _meta?: Record<string, unknown> }): boolean {
  const ui = (tool._meta?.ui ?? {}) as { visibility?: string[] }
  const visibility = ui.visibility
  if (!Array.isArray(visibility) || visibility.length === 0) return true
  return visibility.includes('model')
}

export class MCPServer {
  private server: Server
  private toolRegistry = new ToolRegistry()
  private promptRegistry = new PromptRegistry()
  private resourceRegistry = new ResourceRegistry()

  constructor(name: string, version: string) {
    this.server = new Server(
      { name, version },
      {
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
      },
    )
    this.setupHandlers()
  }

  private setupHandlers() {
    // setRequestHandler's zod-backed generics accumulate variance across 6+
    // call sites and blow TS's depth budget — route through a thin wrapper to
    // reset inference.
    const set = (
      schema: Parameters<Server['setRequestHandler']>[0],
      handler: Parameters<Server['setRequestHandler']>[1],
    ): void => {
      this.server.setRequestHandler(
        schema as Parameters<typeof this.server.setRequestHandler>[0],
        handler as Parameters<typeof this.server.setRequestHandler>[1],
      )
    }

    set(ListToolsRequestSchema, async () => this.getTools())
    set(CallToolRequestSchema, async (request) =>
      this.handleToolCall(request as { params: { name: string; arguments?: unknown } }),
    )
    set(ListPromptsRequestSchema, async () => this.getPrompts())
    set(GetPromptRequestSchema, async (request) =>
      this.handleGetPrompt(request as { params: { name: string; arguments?: unknown } }),
    )
    set(ListResourcesRequestSchema, async () => this.getResources())
    set(ReadResourceRequestSchema, async (request) =>
      this.handleReadResource(request as { params: { uri: string } }),
    )
  }

  getTools() {
    return {
      tools: this.toolRegistry
        .getAll()
        .filter((tool) => isModelVisible(tool))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool._meta ? { _meta: tool._meta } : {}),
        })),
    }
  }

  async handleToolCall(request: {
    params: { name: string; arguments?: unknown }
  }) {
    const toolName = request.params.name
    const tool = this.toolRegistry.get(toolName)

    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`)
    }

    try {
      const validatedArgs = tool.argsSchema.parse(request.params.arguments)
      return await tool.handler(validatedArgs)
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments: ${err.message}`,
        )
      }
      throw err
    }
  }

  registerTool<T extends object>(tool: MCPTool<T>) {
    this.toolRegistry.register(tool)
  }

  getPrompts() {
    return {
      prompts: this.promptRegistry.getAll().map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
    }
  }

  async handleGetPrompt(request: {
    params: { name: string; arguments?: unknown }
  }) {
    const promptName = request.params.name
    const prompt = this.promptRegistry.get(promptName)

    if (!prompt) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown prompt: ${promptName}`,
      )
    }

    try {
      const args = request.params.arguments || {}
      const validatedArgs = prompt.argsSchema.parse(args)

      const result = await prompt.handler(validatedArgs)

      return {
        description: result.description,
        messages: result.messages,
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments: ${err.message}`,
        )
      }
      throw err
    }
  }

  registerPrompt<T extends object>(prompt: MCPPrompt<T>) {
    this.promptRegistry.register(prompt)
  }

  registerResource(resource: MCPResource) {
    this.resourceRegistry.register(resource)
  }

  getResources() {
    return {
      resources: this.resourceRegistry.getAll().map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        ...(resource.annotations ? { annotations: resource.annotations } : {}),
        ...(resource._meta ? { _meta: resource._meta } : {}),
      })),
    }
  }

  async handleReadResource(request: { params: { uri: string } }) {
    const resource = this.resourceRegistry.get(request.params.uri)
    if (!resource) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown resource: ${request.params.uri}`,
      )
    }
    return await resource.read()
  }

  async connect(transport: Transport) {
    await this.server.connect(transport)
  }

  async close() {
    await this.server.close()
  }
}
