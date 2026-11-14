// U5: the loader in coordinator mode. A global setup is a module the coordinator imports itself,
// so it has to go through the project's transform (TypeScript, or the project's own transformer),
// resolve its imports as a worker would, and leave nothing behind in the process.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import type { SerializedLoaderConfig } from '@provino/types'
import { type CoordinatorLoader, createCoordinatorLoader } from './coordinator.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-coordinator-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function config(extra: Partial<SerializedLoaderConfig> = {}): SerializedLoaderConfig {
  return {
    hoist: null,
    moduleScope: [],
    extensions: ['.ts', '.js', '.gs', '.json'],
    conditions: ['node'],
    tsconfig: false,
    mappers: [],
    typescript: 'oxc',
    ...extra,
  }
}

type Setup = (...args: readonly unknown[]) => unknown

test('a globalSetup.ts loads through the transform and its default export runs', async () => {
  const root = writeTree({
    'helper.ts': "export function greet(name: string): string { return 'hello ' + name }\n",
    'globalSetup.ts': [
      "import { greet } from './helper.ts'",
      'interface Config { readonly rootDir: string }',
      'export default async function setup(config: Config): Promise<string> {',
      '  return greet(config.rootDir)',
      '}',
      '',
    ].join('\n'),
  })
  const loader = await createCoordinatorLoader(root, config(), neutralPolicy.module)
  const module = await loader.import<{ default: Setup }>(join(root, 'globalSetup.ts'))
  assert.equal(await module.default({ rootDir: 'there' }), 'hello there')
  loader.dispose()
})

test('a CommonJS setup written in TypeScript works as Jest’s module.exports form', async () => {
  const root = writeTree({
    'setup.ts': [
      'module.exports = async function setup(): Promise<void> {',
      '  ;(globalThis as Record<string, unknown>).__coordinatorSetupRan = true',
      '}',
      '',
    ].join('\n'),
  })
  const loader = await createCoordinatorLoader(root, config(), neutralPolicy.module)
  const module = await loader.import<{ default: Setup }>(join(root, 'setup.ts'))
  await module.default()
  assert.equal(Reflect.get(globalThis, '__coordinatorSetupRan'), true)
  Reflect.deleteProperty(globalThis, '__coordinatorSetupRan')
  loader.dispose()
})

// Turns `.gs` files into CommonJS that exports the file's own text as a function body.
const GS = `
module.exports = {
  createTransformer: () => ({
    process: (source) => ({ code: 'module.exports = function () { return ' + JSON.stringify(source.trim()) + ' }' }),
  }),
}
`

test('the project’s own transformer runs a file it matches', async () => {
  const root = writeTree({ 'gs.cjs': GS, 'setup.gs': 'from the transformer\n' })
  const loader = await createCoordinatorLoader(
    root,
    config({
      transform: {
        rules: [
          {
            pattern: '\\.gs$',
            transformer: { module: join(root, 'gs.cjs'), export: 'default' },
            options: {},
          },
        ],
        ignorePatterns: [],
        config: {},
        hoistedMarkers: [],
      },
    }),
    neutralPolicy.module,
  )
  const module = await loader.import<{ default: Setup }>(join(root, 'setup.gs'))
  assert.equal(module.default(), 'from the transformer')
  loader.dispose()
})

test('a module imported twice is evaluated once, and a module that throws rejects with its error', async () => {
  const root = writeTree({
    'counted.ts':
      'const g = globalThis as Record<string, number>\ng.__coordinatorCount = (g.__coordinatorCount ?? 0) + 1\nexport default 1\n',
    'throws.ts': "throw new Error('setup file broke')\n",
  })
  const loader = await createCoordinatorLoader(root, config(), neutralPolicy.module)
  await loader.import(join(root, 'counted.ts'))
  await loader.import(join(root, 'counted.ts'))
  assert.equal(Reflect.get(globalThis, '__coordinatorCount'), 1)
  Reflect.deleteProperty(globalThis, '__coordinatorCount')
  await assert.rejects(loader.import(join(root, 'throws.ts')), { message: 'setup file broke' })
  loader.dispose()
})

/** The parts of `node:module` the next test watches, typed for assignment (the namespace's are not). */
interface ModuleHookApi {
  readonly _extensions: Readonly<Record<string, unknown>>
  registerHooks: (...args: readonly unknown[]) => unknown
  register: (...args: readonly unknown[]) => unknown
}

test('it installs no hook process-wide: the extension table is as it was, and no module hook was registered', async () => {
  const root = writeTree({ 'a.ts': 'export const a: number = 1\n' })
  const nodeModule = createRequire(import.meta.url)('node:module') as ModuleHookApi
  const extensions = Object.entries(nodeModule._extensions)
  // Count the calls that would install a hook process-wide, for this test only. Named imports of
  // `node:module` see the replacement after `syncBuiltinESMExports`, so they are counted too.
  const original = { registerHooks: nodeModule.registerHooks, register: nodeModule.register }
  const calls: string[] = []
  nodeModule.registerHooks = (...args) => {
    calls.push('registerHooks')
    return Reflect.apply(original.registerHooks, nodeModule, args)
  }
  nodeModule.register = (...args) => {
    calls.push('register')
    return Reflect.apply(original.register, nodeModule, args)
  }
  syncBuiltinESMExports()
  let loader: CoordinatorLoader | undefined
  try {
    loader = await createCoordinatorLoader(root, config(), neutralPolicy.module)
    await loader.import(join(root, 'a.ts'))
    assert.deepEqual(Object.entries(nodeModule._extensions), extensions)
    assert.deepEqual(calls, [], 'module.registerHooks and module.register were not called')
  } finally {
    loader?.dispose()
    nodeModule.registerHooks = original.registerHooks
    nodeModule.register = original.register
    syncBuiltinESMExports()
  }
})

test('resolveDependency resolves as a require does: files, extensions, mappers, and nothing for a builtin or a miss', async () => {
  const dir = writeTree({
    'a.ts': 'export {}\n',
    'lib/index.ts': 'export {}\n',
    'data.json': '{}\n',
  })
  using loader = await createCoordinatorLoader(
    dir,
    config({ aliases: [{ pattern: '^@lib$', targets: ['<rootDir>/lib/index.ts'] }] }),
    neutralPolicy.module,
  )
  const from = join(dir, 'a.ts')
  assert.equal(loader.resolveDependency('./a', join(dir, 'b.ts')), from)
  assert.equal(loader.resolveDependency('./lib', from), join(dir, 'lib/index.ts'))
  assert.equal(loader.resolveDependency('./data.json', from), join(dir, 'data.json'))
  assert.equal(loader.resolveDependency('@lib', from), join(dir, 'lib/index.ts'))
  assert.equal(loader.resolveDependency('node:fs', from), undefined)
  assert.equal(loader.resolveDependency('./missing', from), undefined)
})
