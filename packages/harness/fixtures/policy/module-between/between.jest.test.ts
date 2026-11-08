// The same module, loaded in two tests.
const load = (): { loads: number } => require('./counter-cjs.ts') as { loads: number }

test('loads the module', () => {
  load()
})

test('loads it again', () => observe('module.resetModulesBetween', () => load().loads !== 1))

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
