import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

// `.env` lives at the repo root (one level up); fall back to mcp-server-local
// overrides when present. Merge order: repo root → package dir (latter wins).
const cwd = process.cwd()
const envFromRepoRoot = loadEnv('', resolve(cwd, '..'), '')
const envFromPackage = loadEnv('', cwd, '')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: { ...envFromRepoRoot, ...envFromPackage },
    testTimeout: 10000,
    coverage: {
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.test.ts', '**/*.spec.ts'],
          exclude: [
            '**/*.integration.test.ts',
            'node_modules/**',
            'dist/**',
            'build/**',
          ],
          pool: 'threads',
          poolOptions: {
            threads: {
              singleThread: false,
            },
          },
          globalSetup: ['./tests/globalSetup.ts'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['node_modules/**', 'dist/**', 'build/**'],
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          fileParallelism: false,
          testTimeout: 30000,
          retry: 3,
          globalSetup: ['./tests/globalSetup.ts'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
})
