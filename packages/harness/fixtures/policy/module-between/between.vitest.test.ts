// The same module, loaded in two tests.
const load = (): Promise<{ loads: number }> => import('./counter-esm.ts')

test('loads the module', async () => {
  await load()
})

test('loads it again', async () => {
  const { loads } = await load()
  await observe('module.resetModulesBetween', () => loads !== 1)
})

test('sees the CommonJS globals', () =>
  observe('module.injectCjsGlobals', () => {
    const seen = {
      __dirname: typeof __dirname,
      __filename: typeof __filename,
      require: typeof require,
      module: typeof module,
    }
    return Object.values(seen).every((kind) => kind !== 'undefined') ? true : seen
  }))
