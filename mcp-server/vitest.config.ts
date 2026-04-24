import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

// `.env` lives at the repo root (one level up); package-local overrides win
// when present. Merge order: repo root → package dir.
const cwd = process.cwd()
const envFromRepoRoot = loadEnv('', resolve(cwd, '..'), '')
const envFromPackage = loadEnv('', cwd, '')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: { ...envFromRepoRoot, ...envFromPackage },
    testTimeout: 10000,
    setupFiles: ['./tests/setup.ts'],
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
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['node_modules/**', 'dist/**', 'build/**'],
          testTimeout: 30000,
          retry: 3,
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
})
