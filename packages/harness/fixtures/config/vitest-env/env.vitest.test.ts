const keys = ['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'VITE_FROM_PROCESS', 'NOT_PREFIXED']
const env: Record<string, unknown> = import.meta.env

for (const key of keys) {
  test(`${key}=${JSON.stringify(env[key]) ?? 'undefined'}`, () => {
    expect(true).toBe(true)
  })
}
