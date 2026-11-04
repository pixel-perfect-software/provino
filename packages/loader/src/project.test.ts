import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import type { SerializedLoaderConfig } from '@provino/types'
import { createProjectLoader } from './project.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-project-loader-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const CONFIG: SerializedLoaderConfig = {
  extensions: ['.ts', '.js', '.cjs', '.json'],
  conditions: ['node'],
  tsconfig: false,
  mappers: [],
  typescript: 'oxc',
}

test('a project loader loads a TypeScript file and a CommonJS file', async () => {
  const root = writeTree({
    'helper.cjs': "exports.prefix = 'hi '\n",
    'entry.test.ts': [
      "import helper from './helper.cjs'",
      'const greet = (name: string): string => helper.prefix + name',
      "export const greeting: string = greet('ada')",
      "export const required = (await import('./helper.cjs')).prefix",
      '',
    ].join('\n'),
  })
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  assert.equal(loader.engine, 'runner')
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  const entry = await registry.import<{ greeting: string; required: string }>(
    join(root, 'entry.test.ts'),
  )
  assert.equal(entry.greeting, 'hi ada')
  assert.equal(entry.required, 'hi ')
  assert.equal(registry.require<{ prefix: string }>(join(root, 'helper.cjs')).prefix, 'hi ')
})

test('the config’s extensions, conditions and mappers reach the resolver', async () => {
  const root = writeTree({
    'mapper.ts': [
      'export const aliasMapper = (options: { from: string; to: string }) => ({',
      "  id: 'alias',",
      '  map: (specifier: string) =>',
      "    specifier === options.from ? { candidates: [options.to], onMiss: 'error', rule: options.from } : null,",
      '})',
      '',
    ].join('\n'),
    'real.ts': 'export const where: string = "real"\n',
    'only-ts.ts': 'export const ext: string = "ts"\n',
    'node_modules/cond/package.json': JSON.stringify({
      name: 'cond',
      exports: { '.': { custom: './custom.js', default: './default.js' } },
    }),
    'node_modules/cond/custom.js': 'module.exports = { which: "custom" }\n',
    'node_modules/cond/default.js': 'module.exports = { which: "default" }\n',
    'entry.test.ts': [
      "import { where } from '@alias/real'",
      "import { ext } from './only-ts'",
      "import cond from 'cond'",
      'export { where, ext }',
      'export const which: string = cond.which',
      '',
    ].join('\n'),
  })
  const loader = await createProjectLoader(
    root,
    {
      ...CONFIG,
      conditions: ['custom', 'node'],
      mappers: [
        {
          factory: { module: join(root, 'mapper.ts'), export: 'aliasMapper' },
          options: { from: '@alias/real', to: join(root, 'real.ts') },
        },
      ],
    },
    neutralPolicy.module,
  )
  const entry = await loader
    .createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
    .import<{ where: string; ext: string; which: string }>(join(root, 'entry.test.ts'))
  assert.deepEqual({ ...entry }, { where: 'real', ext: 'ts', which: 'custom' })
})

test('a mapper ref that does not load rejects, with the ref in the message', async () => {
  const root = writeTree({})
  await assert.rejects(
    createProjectLoader(
      root,
      {
        ...CONFIG,
        mappers: [{ factory: { module: join(root, 'missing.ts'), export: 'nope' }, options: null }],
      },
      neutralPolicy.module,
    ),
    { code: 'POLICY_BEHAVIOUR_LOAD_FAILED' },
  )
})

test("tsconfig 'auto' finds the nearest tsconfig.json, so its paths alias resolves", async () => {
  const root = writeTree({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['./lib/*'] } } }),
    'lib/util.ts': 'export const util: number = 7\n',
    'entry.test.ts': "export { util } from '@lib/util'\n",
  })
  const loader = await createProjectLoader(
    root,
    { ...CONFIG, tsconfig: 'auto' },
    neutralPolicy.module,
  )
  const entry = await loader
    .createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
    .import<{ util: number }>(join(root, 'entry.test.ts'))
  assert.equal(entry.util, 7)
})

test('a tsconfig path is that file, and false is none', async () => {
  const root = writeTree({
    'config/paths.json': JSON.stringify({
      compilerOptions: { paths: { '@lib/*': ['../lib/*'] } },
    }),
    'lib/util.ts': 'export const util: number = 7\n',
    'entry.test.ts': "export { util } from '@lib/util'\n",
  })
  const file = join(root, 'entry.test.ts')
  const named = await createProjectLoader(
    root,
    { ...CONFIG, tsconfig: join(root, 'config/paths.json') },
    neutralPolicy.module,
  )
  const entry = await named
    .createFileRegistry(file, { tier: 'registry' })
    .import<{ util: number }>(file)
  assert.equal(entry.util, 7)

  const none = await createProjectLoader(root, { ...CONFIG, tsconfig: false }, neutralPolicy.module)
  await assert.rejects(none.createFileRegistry(file, { tier: 'registry' }).import(file), {
    code: 'ERR_MODULE_NOT_FOUND',
    message: /@lib\/util/,
  })
})

test('a relative tsconfig path is read against root, not the process cwd', async () => {
  const root = writeTree({
    'config/paths.json': JSON.stringify({
      compilerOptions: { paths: { '@lib/*': ['../lib/*'] } },
    }),
    'lib/util.ts': 'export const util: number = 7\n',
    'entry.test.ts': "export { util } from '@lib/util'\n",
  })
  assert.notEqual(realpathSync(process.cwd()), root, 'the test needs cwd to differ from root')
  const file = join(root, 'entry.test.ts')
  const loader = await createProjectLoader(
    root,
    { ...CONFIG, tsconfig: 'config/paths.json' },
    neutralPolicy.module,
  )
  const entry = await loader
    .createFileRegistry(file, { tier: 'registry' })
    .import<{ util: number }>(file)
  assert.equal(entry.util, 7)
})

test('a tsconfig path that is not a file throws a coded error naming it', async () => {
  const root = writeTree({ 'config/dir/placeholder.txt': '' })
  for (const [tsconfig, resolved] of [
    ['config/nope.json', join(root, 'config/nope.json')],
    [join(root, 'absent.json'), join(root, 'absent.json')],
    ['config/dir', join(root, 'config/dir')],
  ] as const) {
    await assert.rejects(
      createProjectLoader(root, { ...CONFIG, tsconfig }, neutralPolicy.module),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'LOADER_TSCONFIG_NOT_FOUND', tsconfig)
        assert.ok(String((error as Error).message).includes(resolved), (error as Error).message)
        return true
      },
    )
  }
})

test('a mapper factory that returns no mapper throws a coded error naming its index', async () => {
  const root = writeTree({
    'mapper.ts': [
      'export const good = () => ({ id: "good", map: () => null })',
      'export const nothing = () => undefined',
      'export const noMap = () => ({ id: "no-map" })',
      'export const noId = () => ({ map: () => null })',
      'export const throws = () => { throw new Error("bad options") }',
      '',
    ].join('\n'),
  })
  const mapperAt = (name: string) => ({
    factory: { module: join(root, 'mapper.ts'), export: name },
    options: null,
  })
  for (const name of ['nothing', 'noMap', 'noId', 'throws']) {
    await assert.rejects(
      createProjectLoader(
        root,
        { ...CONFIG, mappers: [mapperAt('good'), mapperAt(name)] },
        neutralPolicy.module,
      ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'LOADER_INVALID_MAPPER', name)
        assert.match(String((error as Error).message), /loader\.mappers\[1\]/, name)
        if (name === 'throws') assert.equal((error as Error).cause instanceof Error, true)
        return true
      },
    )
  }
})
