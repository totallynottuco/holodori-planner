import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@data': resolve('src/data'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    coverage: { reporter: ['text', 'html'] }
  }
})
