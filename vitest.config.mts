import { defineConfig } from 'vitest/config'

/**
 * Vitest runs everything from plain Node: no browser, no extension host, no
 * network. Anything that needs the `vscode` module must live in a test that
 * does not execute under Node, so those are excluded here.
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'out/**', 'apps/vscode-extension/src/main.ts'],
    environment: 'node',
  },
})
