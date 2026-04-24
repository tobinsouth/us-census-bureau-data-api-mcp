export interface ResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  _meta?: Record<string, unknown>
}

export interface ResourceAnnotations {
  audience?: Array<'user' | 'assistant'>
  priority?: number
}

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
  annotations?: ResourceAnnotations
  _meta?: Record<string, unknown>
  read: () => Promise<{ contents: ResourceContent[] }>
}

export class ResourceRegistry {
  private resources = new Map<string, MCPResource>()

  register(resource: MCPResource): void {
    this.resources.set(resource.uri, resource)
  }

  getAll(): MCPResource[] {
    return Array.from(this.resources.values())
  }

  get(uri: string): MCPResource | undefined {
    return this.resources.get(uri)
  }

  has(uri: string): boolean {
    return this.resources.has(uri)
  }
}
