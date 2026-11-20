// B25c, T11.15, T3.3: the reader held to what Vitest 5.0.5 resolved, recorded by the harness
// (`fixtures/config/vitest-*`, `fixtures/resolve/vite-alias-*`). Each fixture's test prints the
// worker's own resolved config (`getWorkerState().config`, D27) or what an aliased import gave, in
// its titles; here the reader reads the same config and must give the same values. What the
// recording shows and the reader does differently is named where it is asserted.
import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolvePolicy } from '@provino/policy'
import type { NeutralProject, Policy } from '@provino/types'
import { vitestPolicy } from '../dialect.ts'
import { globToRegexSource } from './glob.ts'
import { readVitestConfig } from './index.ts'
import { writeTree } from './test-support.ts'

const FIXTURES = fileURLToPath(new URL('../../../harness/fixtures/', import.meta.url))

interface Recording {
  readonly manifest: {
    readonly config?: { readonly vitest?: { readonly test?: Record<string, unknown> } }
    readonly env?: Record<string, string>
  }
  /** Each file that ran, with the `key=value` titles of its tests. */
  readonly files: readonly {
    readonly file: string
    readonly values: ReadonlyMap<string, unknown>
  }[]
  readonly titles: readonly (readonly [file: string, title: string])[]
}

function record(id: string): Recording {
  const dir = join(FIXTURES, id)
  const manifest: Recording['manifest'] = JSON.parse(
    readFileSync(join(dir, 'fixture.json'), 'utf8'),
  )
  const golden: { files: { file: string; tests: { id: { path: string[] } }[] }[] } = JSON.parse(
    readFileSync(join(dir, '__goldens__/vitest.json'), 'utf8'),
  )
  const titles: [string, string][] = []
  const files = golden.files.flatMap((file) => {
    const values = new Map<string, unknown>()
    for (const entry of file.tests) {
      const title = entry.id.path.join(' > ')
      titles.push([file.file, title])
      const cut = title.indexOf('=')
      if (cut === -1) continue
      const text = title.slice(cut + 1)
      values.set(title.slice(0, cut), text === 'undefined' ? undefined : JSON.parse(text))
    }
    return [{ file: file.file, values }]
  })
  return { manifest, files, titles }
}

/** The config the recorder writes for a fixture, as far as the reader needs it (no setup files). */
function recorderConfig(test: Record<string, unknown>): string {
  const base = {
    test: {
      globals: true,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/__goldens__/**', '**/*.jest.test.ts'],
      ...test,
    },
  }
  return `export default ${JSON.stringify(base)}\n`
}

function effective(project: NeutralProject): Policy {
  return resolvePolicy(vitestPolicy, project.policy)
}

function hooksOf(policy: Policy): string {
  const order = policy.core.hookOrder
  if (order.afterEach === 'parallel') return 'parallel'
  return order.afterEach === 'reverse' ? 'stack' : 'list'
}

/** What the reader says for each key the observing test prints, as the worker would print it. */
function readerValue(key: string, project: NeutralProject, env: string): unknown {
  const policy = effective(project)
  switch (key) {
    case 'testTimeout':
      return policy.core.timeouts.test
    case 'hookTimeout':
      return policy.core.timeouts.hook
    case 'isolate':
      return policy.orchestrator.isolationDefault.default !== 'none'
    case 'pool':
      return policy.orchestrator.pool.default
    case 'globals':
      return policy.core.injectGlobals
    case 'clearMocks':
      return policy.mock.between.clear
    case 'mockReset':
      return policy.mock.between.reset
    case 'restoreMocks':
      return policy.mock.between.restore
    case 'unstubGlobals':
      return policy.mock.between.unstubGlobals
    case 'unstubEnvs':
      return policy.mock.between.unstubEnvs
    case 'maxConcurrency':
      return policy.core.maxConcurrency
    case 'sequence.hooks':
      return hooksOf(policy)
    case 'sequence.shuffle':
      return project.randomize === true ? true : undefined
    case 'passWithNoTests':
      return policy.orchestrator.passWithNoTests ? true : undefined
    case 'environmentOptions':
      return Object.keys(project.environment.options).length === 0
        ? undefined
        : { [env]: project.environment.options }
    case 'snapshotOptions.snapshotFormat': {
      const { escapeString, printBasicPrototype } = policy.snapshot.format
      return { escapeString, printBasicPrototype }
    }
    default:
      throw new Error(`no reader value for ${key}`)
  }
}

/** Keys the reader reads and does not apply yet: it warns instead, so the recording is not compared. */
const WARNED = new Set(['retry'])

for (const id of ['config/vitest-defaults', 'config/vitest-options']) {
  test(`the reader gives what Vitest resolved: ${id}`, async () => {
    const recording = record(id)
    const overlay = recording.manifest.config?.vitest?.test ?? {}
    const root = writeTree({ 'vitest.config.mjs': recorderConfig(overlay) })
    const { projects, diagnostics } = await readVitestConfig({ cwd: root })
    const project = projects[0]
    assert.ok(project)
    const file = recording.files[0]
    assert.ok(file)
    let compared = 0
    for (const [key, golden] of file.values) {
      if (WARNED.has(key)) {
        assert.ok(
          golden === undefined || diagnostics.some((entry) => entry.key === `test.${key}`),
          `${key} is warned about`,
        )
        continue
      }
      const got = readerValue(key, project, 'node')
      if (key === 'snapshotOptions.snapshotFormat') {
        // Vitest's own defaults fill the rest; the keys the config sets must be the reader's.
        for (const [name, value] of Object.entries(golden as Record<string, unknown>)) {
          assert.equal((got as Record<string, unknown>)[name], value, `${key}.${name}`)
        }
      } else if (key === 'sequence.shuffle') {
        // The config says `false` where the reader leaves the key off.
        assert.equal(got === true, golden === true, key)
      } else {
        assert.deepEqual(got, golden, key)
      }
      compared++
    }
    assert.ok(compared >= 15, `compared ${compared} keys`)
  })
}

test("import.meta.env: MODE, DEV, PROD, SSR, BASE_URL and a VITE_ variable equal Vitest's", async () => {
  const recording = record('config/vitest-env')
  const root = writeTree({ 'vitest.config.mjs': recorderConfig({}) })
  const { projects } = await readVitestConfig({
    cwd: root,
    env: { ...recording.manifest.env, NODE_ENV: 'test' },
  })
  const env = projects[0]?.importMetaEnv
  assert.ok(env)
  const golden = recording.files[0]?.values
  assert.ok(golden)
  for (const key of ['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'VITE_FROM_PROCESS']) {
    assert.equal(env[key], golden.get(key), key)
  }
  // Vitest's import.meta.env also shows the whole process environment; the reader's holds the
  // prefixed variables only (the worker adds process.env, B25f).
  assert.equal(golden.get('NOT_PREFIXED'), 'n')
  assert.equal(env.NOT_PREFIXED, undefined)
})

/** Every `*.test.ts` under `dir`, relative POSIX paths, as the recorder selects test files. */
function testFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const relative = prefix === '' ? name : `${prefix}/${name}`
    if (name === '__goldens__' || name === 'node_modules') continue
    if (statSync(join(dir, relative)).isDirectory()) out.push(...testFiles(dir, relative))
    else if (name.endsWith('.test.ts') && !name.endsWith('.jest.test.ts')) out.push(relative)
  }
  return out
}

/** A copy of a fixture's tree, with the recorder's root config written beside its files. */
function copyFixture(id: string, rootTest: Record<string, unknown>): string {
  const root = writeTree({ 'vitest.config.ts': recorderConfig(rootTest) })
  cpSync(join(FIXTURES, id), root, {
    recursive: true,
    filter: (source) => !source.includes('__goldens__') && basename(source) !== 'fixture.json',
  })
  return root
}

/** Which of `files` (root-relative) a project's include and exclude globs pick, as Vitest does. */
function picked(project: NeutralProject, root: string, files: readonly string[]): string[] {
  const include = project.discovery.includePatterns.patterns.map(
    (glob) => new RegExp(globToRegexSource(glob, project.rootDir)),
  )
  const exclude = project.discovery.excludePatterns.map((source) => new RegExp(source))
  return files.filter((file) => {
    const absolute = join(root, file)
    return (
      absolute.startsWith(project.rootDir) &&
      include.some((regex) => regex.test(absolute)) &&
      !exclude.some((regex) => regex.test(absolute))
    )
  })
}

async function projectRuns(
  id: string,
  keys: readonly string[],
): Promise<{ expected: string[]; got: string[] }> {
  const recording = record(id)
  const rootTest = recording.manifest.config?.vitest?.test ?? {}
  const root = copyFixture(id, rootTest)
  const { projects } = await readVitestConfig({ cwd: root })
  const files = testFiles(root)
  const show = (value: unknown): string => JSON.stringify(value) ?? 'undefined'
  const expected = recording.files.map((entry) =>
    [entry.file, ...keys.map((key) => `${key}=${show(entry.values.get(key))}`)].join(' '),
  )
  const got: string[] = []
  for (const project of projects) {
    const values: Record<string, unknown> = {
      name: project.name,
      rootName: project.rootDir === root ? '<root>' : basename(project.rootDir),
      testTimeout: effective(project).core.timeouts.test,
      hookTimeout: effective(project).core.timeouts.hook,
      globals: effective(project).core.injectGlobals,
      isolate: effective(project).orchestrator.isolationDefault.default !== 'none',
    }
    for (const file of picked(project, root, files)) {
      got.push([file, ...keys.map((key) => `${key}=${show(values[key])}`)].join(' '))
    }
  }
  return { expected: expected.sort(), got: got.sort() }
}

test("test.projects: the projects, their roots and the files each one runs equal Vitest's", async () => {
  const { expected, got } = await projectRuns('config/vitest-projects', [
    'name',
    'rootName',
    'testTimeout',
    'hookTimeout',
    'globals',
    'isolate',
  ])
  assert.ok(expected.length >= 10)
  assert.deepEqual(got, expected)
})

test('a function export, defineConfig and mergeConfig give what Vitest resolved', async () => {
  const { expected, got } = await projectRuns('config/vitest-config-forms', ['name', 'testTimeout'])
  assert.equal(expected.length, 3)
  assert.deepEqual(got, expected)
})

/** The `$n` replacement of the loader's name mapper: the first rule that matches decides. */
function mapped(project: NeutralProject, specifier: string): string {
  for (const rule of project.aliases) {
    const match = specifier.match(new RegExp(rule.pattern))
    if (match === null) continue
    return (rule.targets[0] as string).replaceAll(
      /\$(\d+)/g,
      (_, index: string) => match[Number(index)] ?? '',
    )
  }
  return specifier
}

/** What importing `path` finds: the file, `path.js`, or a directory's index; `export default 'v'`. */
function importedValue(path: string): string {
  for (const candidate of [path, `${path}.js`, join(path, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return /export default '([^']*)'/.exec(readFileSync(candidate, 'utf8'))?.[1] ?? 'unresolved'
    }
  }
  return 'unresolved'
}

for (const id of [
  'resolve/vite-alias-string',
  'resolve/vite-alias-regex',
  'resolve/vite-alias-order',
]) {
  test(`the reader's aliases send each specifier where Vite does: ${id}`, async () => {
    const recording = record(id)
    const proj = join(FIXTURES, id, 'proj')
    const source = readFileSync(join(proj, 'alias.test.ts'), 'utf8')
    const list = /const specs: string\[\] = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    const specs = [...list.matchAll(/'([^']*)'|"([^"]*)"/g)].map(
      (match) => match[1] ?? match[2] ?? '',
    )
    assert.ok(specs.length >= 3)
    const { projects } = await readVitestConfig({ cwd: proj })
    const project = projects[0]
    assert.ok(project)
    for (const spec of specs) {
      const target = mapped(project, spec)
      const path = target.startsWith('.') ? resolve(proj, target) : target
      const got = `${spec} -> ${target.startsWith('/') || target.startsWith('.') ? importedValue(path) : 'unresolved'}`
      const golden = recording.titles.find(([, title]) => title.startsWith(`${spec} -> `))?.[1]
      assert.equal(got, golden, spec)
    }
  })
}
