// A variable and a global stubbed in test 1, seen in test 2.
const target = globalThis as Record<string, unknown>

test('test 1 stubs an environment variable and a global', () => {
  vi.stubEnv('PROVINO_CLEANUP_ENV', 'stubbed')
  vi.stubGlobal('provinoCleanupGlobal', 'stubbed')
})

test('test 2 observes what is left', () =>
  observe('stubs in test 2', () => {
    const state = {
      env: process.env.PROVINO_CLEANUP_ENV,
      global: target.provinoCleanupGlobal,
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    return state
  }))
