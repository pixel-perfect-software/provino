import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'

const base = defineConfig({
  test: { name: 'merged', include: ['src/**/*.test.ts'], testTimeout: 66 },
})

export default mergeConfig(
  base,
  defineConfig({ test: { include: ['extra/**/*.test.ts'], exclude: [...configDefaults.exclude] } }),
)
