import { vi } from 'vitest'

// Silence console.warn/error/info during tests. Tool handlers surface errors
// through their return value, so reading them off stderr is pure noise.
global.console = {
  ...console,
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}

// Default global fetch to a spy — individual tests override it or mock
// node-fetch directly via vi.mock('node-fetch').
global.fetch = vi.fn()
