// T8.6: the Vitest environments against Vitest 5.0.5's own recordings. Each `env/vitest-*` fixture
// of `@provino/harness` holds what a file saw there, one observation a test; here each test's
// condition runs inside the environment Provino builds for the same config (a child process per
// environment, since it populates that process's global), and must hold exactly where the
// recorded test passed. Then the teardown must put the global back.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { JsonValue } from '@provino/types'
import type { SmokeResult, SmokeSpec } from './internal/environment-smoke.ts'
import {
  fromVitestEnvironment,
  vitestEnvironment,
  vitestEnvironmentFor,
  vitestEnvironmentRef,
} from './vitest-environment.ts'

const run = promisify(execFile)
const SMOKE = fileURLToPath(new URL('./internal/environment-smoke.ts', import.meta.url))
const FIXTURES = fileURLToPath(new URL('../../../harness/fixtures/env/', import.meta.url))
/** This package's root: jsdom, happy-dom and `@edge-runtime/vm` are its devDependencies. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface Golden {
  readonly files: readonly {
    readonly file: string
    readonly tests: readonly {
      readonly id: { readonly path: readonly string[] }
      readonly status: string
    }[]
  }[]
}

/** Each recorded test of one file of a fixture: its title and whether it passed. */
async function recorded(fixture: string, file: string): Promise<Map<string, boolean>> {
  const golden = JSON.parse(
    await readFile(join(FIXTURES, fixture, '__goldens__', 'vitest.json'), 'utf8'),
  ) as Golden
  const found = golden.files.find((entry) => entry.file === file)
  assert.ok(found, `${fixture} records ${file}`)
  return new Map(found.tests.map((test) => [test.id.path.join(' > '), test.status === 'passed']))
}

async function smoke(spec: SmokeSpec, checks: Record<string, string>): Promise<SmokeResult> {
  const { stdout } = await run(
    process.execPath,
    ['--conditions=provino-source', SMOKE, JSON.stringify(spec), JSON.stringify(checks)],
    { timeout: 60_000 },
  )
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as SmokeResult
}

/** A process singleton a library defines once and never removes is not a leak. */
const isOwnLeak = (key: string): boolean => !key.startsWith('Symbol(undici.')

/** Holds every recorded test of the file to its condition, then the teardown to an exact restore. */
async function holds(
  fixture: string,
  file: string,
  spec: SmokeSpec,
  checks: Record<string, string>,
): Promise<void> {
  const golden = await recorded(fixture, file)
  assert.deepEqual([...Object.keys(checks)].sort(), [...golden.keys()].sort())
  const result = await smoke(spec, checks)
  for (const [title, passed] of golden) {
    assert.equal(result.results[title], passed, `${fixture} ${file}: ${title}`)
  }
  // undici defines its dispatcher symbols once per process, when `fetch` is first read.
  assert.deepEqual(result.leaked.filter(isOwnLeak), [])
  assert.deepEqual(result.missing, [])
  assert.equal(result.documentAfter, 'undefined')
}

const WINDOW = {
  'window, self and globalThis are one object': 'window === globalThis && self === globalThis',
  'the default URL is http://localhost:3000/': "location.href === 'http://localhost:3000/'",
  'a DOM write reads back':
    "(document.body.innerHTML = '<p id=\"x\">hello</p>', document.getElementById('x')?.textContent === 'hello')",
}

const project = (
  name: string,
  environmentOptions: { readonly [key: string]: JsonValue },
  rootDir: string = ROOT,
): SmokeSpec => ({ kind: 'project', name, environmentOptions, rootDir })

describe('the Vitest environments against Vitest 5.0.5 (T8.6)', () => {
  it("jsdom: @provino/env-jsdom over the project's jsdom (env/vitest-jsdom)", async () => {
    await holds('vitest-jsdom', 'vitest-jsdom.vitest.test.ts', project('jsdom', {}), {
      ...WINDOW,
      'the user agent names jsdom': '/jsdom/.test(navigator.userAgent)',
      'Buffer and fetch are there':
        "[typeof Buffer, typeof fetch, typeof Request, typeof AbortController].every((t) => t === 'function')",
      'document.defaultView is the global': 'document.defaultView === globalThis',
    })
  })

  it("happy-dom: the vendored setup over the project's happy-dom (env/vitest-happy-dom)", async () => {
    await holds(
      'vitest-happy-dom',
      'vitest-happy-dom.vitest.test.ts',
      project('happy-dom', { happyDOM: { width: 640 } }),
      {
        ...WINDOW,
        'the user agent names HappyDOM': '/HappyDOM/.test(navigator.userAgent)',
        'environmentOptions.happyDOM.width reaches the window': 'innerWidth === 640',
        'Buffer is on the window': "typeof Buffer === 'function'",
      },
    )
  })

  it("edge-runtime: the vendored setup over the project's @edge-runtime/vm (env/vitest-edge-runtime)", async () => {
    await holds(
      'vitest-edge-runtime',
      'vitest-edge-runtime.vitest.test.ts',
      project('edge-runtime', {}),
      {
        'EdgeRuntime is a string': "typeof EdgeRuntime === 'string'",
        'there is no document': "typeof document === 'undefined'",
        'window is the global': "typeof window === 'object' && window === globalThis",
        'Buffer and fetch are there':
          "[typeof Buffer, typeof fetch, typeof Response].every((t) => t === 'function')",
      },
    )
  })

  it('a vitest-environment-<name> package from the project, given the whole environmentOptions (env/vitest-custom-package)', async () => {
    const manifest = JSON.parse(
      await readFile(join(FIXTURES, 'vitest-custom-package', 'fixture.json'), 'utf8'),
    ) as { packages: Record<string, Record<string, string>> }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-env-')))
    try {
      for (const [name, files] of Object.entries(manifest.packages)) {
        for (const [file, text] of Object.entries(files)) {
          const path = join(root, 'node_modules', name, file)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, text)
        }
      }
      await holds(
        'vitest-custom-package',
        'vitest-custom-package.vitest.test.ts',
        project('provino-custom', { 'provino-custom': { flag: 'on' } }, root),
        {
          'setup got the whole environmentOptions object':
            "JSON.stringify(JSON.parse(__customOptions)) === JSON.stringify({ 'provino-custom': { flag: 'on' } })",
          'setup ran once for the file': '__customSetups === 1',
          'there is no document': "typeof document === 'undefined'",
        },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a @vitest-environment or @jest-environment docblock picks the environment (env/vitest-docblock)', async () => {
    const node = { name: 'node', environmentOptions: {} }
    await holds('vitest-docblock', 'node.vitest.test.ts', project('node', {}), {
      'there is no document': "typeof document === 'undefined'",
    })
    await holds(
      'vitest-docblock',
      'vitest-pragma.vitest.test.ts',
      { kind: 'docblock', name: 'jsdom', options: null, base: node, rootDir: ROOT },
      { 'the vitest pragma gives a jsdom window': '/jsdom/.test(navigator.userAgent)' },
    )
    await holds(
      'vitest-docblock',
      'jest-pragma.vitest.test.ts',
      { kind: 'docblock', name: 'happy-dom', options: null, base: node, rootDir: ROOT },
      { 'the jest pragma gives a happy-dom window': '/HappyDOM/.test(navigator.userAgent)' },
    )
  })

  it("environmentOptions reach the project's files; a docblock's options replace them (env/vitest-options)", async () => {
    const environmentOptions = {
      jsdom: { url: 'http://example.test/base', userAgent: 'provino-project' },
    }
    await holds('vitest-options', 'project.vitest.test.ts', project('jsdom', environmentOptions), {
      'the URL is the project option': "location.href === 'http://example.test/base'",
      'the user agent is the project option': "navigator.userAgent === 'provino-project'",
    })
    await holds(
      'vitest-options',
      'docblock.vitest.test.ts',
      {
        kind: 'docblock',
        name: 'jsdom',
        options: { url: 'http://example.test/file' },
        base: { name: 'jsdom', environmentOptions },
        rootDir: ROOT,
      },
      {
        'the URL is the docblock option': "location.href === 'http://example.test/file'",
        'the project user agent is not merged in': '/jsdom/.test(navigator.userAgent)',
      },
    )
  })
})

describe("a docblock with no -options gets the project's whole environmentOptions (runtime/workers/base.ts)", () => {
  it('a jsdom docblock in a node project reads environmentOptions.jsdom', async () => {
    const result = await smoke(
      {
        kind: 'docblock',
        name: 'jsdom',
        options: null,
        base: {
          name: 'node',
          environmentOptions: { jsdom: { url: 'http://example.test/project' } },
        },
        rootDir: ROOT,
      },
      { 'the URL is the project option': "location.href === 'http://example.test/project'" },
    )
    assert.equal(result.results['the URL is the project option'], true)
  })
})

describe("Vitest's jsdom options reach the JSDOM constructor, as Vitest 5.0.5's jsdom.ts reads them", () => {
  /** Runs every check under one project and asserts each held, then an exact restore. */
  async function allHold(
    environmentOptions: { readonly [key: string]: JsonValue },
    checks: Record<string, string>,
  ): Promise<void> {
    const result = await smoke(project('jsdom', environmentOptions), checks)
    for (const title of Object.keys(checks)) assert.equal(result.results[title], true, title)
    assert.deepEqual(result.leaked.filter(isOwnLeak), [])
    assert.deepEqual(result.missing, [])
  }

  it('runScripts, includeNodeLocations, cookieJar, console and the rest of the keys', async () => {
    await allHold(
      {
        jsdom: {
          html: '<!DOCTYPE html><html><head><script>window.ran = true</script></head><body></body></html>',
          runScripts: 'outside-only',
          includeNodeLocations: true,
          cookieJar: true,
          console: true,
          referrer: 'https://ref.test/',
        },
      },
      {
        'runScripts: outside-only runs no inline script': "!('ran' in globalThis)",
        'includeNodeLocations: the body has a location':
          'jsdom.nodeLocation(document.body) !== null',
        'cookieJar: a cookie reads back': "(document.cookie = 'a=1', document.cookie === 'a=1')",
        'a key Vitest spreads into the constructor (referrer)':
          "document.referrer === 'https://ref.test/'",
      },
    )
  })

  it('contentType parses an XHTML document', async () => {
    await allHold(
      {
        jsdom: {
          contentType: 'application/xhtml+xml',
          html: '<html xmlns="http://www.w3.org/1999/xhtml"><body></body></html>',
        },
      },
      { 'the document is XHTML': "document.contentType === 'application/xhtml+xml'" },
    )
  })
})

/** Writes `files` (path to text) under a fresh temporary root. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-env-')))
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), text)
  }
  return root
}

const ENV_SOURCE = "{ name: 'pkg', setup() { return { teardown() {} } } }"

describe('the refs and the adapter', () => {
  it('an ES-module-only environment package resolves through its import condition, as Vitest imports it', async () => {
    const root = await tree({
      'node_modules/vitest-environment-esm/package.json':
        '{"name": "vitest-environment-esm", "type": "module", "exports": {".": {"import": "./index.js"}}}',
      'node_modules/vitest-environment-esm/index.js': `export default ${ENV_SOURCE}\n`,
    })
    try {
      const ref = vitestEnvironmentRef('esm', {}, root)
      const prepared = (await vitestEnvironment.prepare?.(ref.options as never)) as {
        setup?: unknown
      }
      assert.equal(typeof prepared.setup, 'function')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a dual environment package loads its ES module build, whose default is the environment', async () => {
    const root = await tree({
      'node_modules/vitest-environment-dual/package.json':
        '{"name": "vitest-environment-dual", "exports": {".": {"import": "./index.mjs", "require": "./index.cjs"}}}',
      'node_modules/vitest-environment-dual/index.mjs': `export default ${ENV_SOURCE}\n`,
      'node_modules/vitest-environment-dual/index.cjs': `exports.default = ${ENV_SOURCE}\n`,
    })
    try {
      const ref = vitestEnvironmentRef('dual', {}, root)
      assert.match(String(ref.options.module), /index\.mjs$/)
      const prepared = (await vitestEnvironment.prepare?.(ref.options as never)) as {
        setup?: unknown
      }
      assert.equal(typeof prepared.setup, 'function')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a setup that returns nothing puts the global back and names the environment', async () => {
    const environment = fromVitestEnvironment({
      name: 'returns-nothing',
      setup(global) {
        ;(global as { __leaked?: number }).__leaked = 1
        return undefined as never
      },
    })
    await assert.rejects(async () => environment.setup({} as never, undefined), {
      code: 'VITEST_ENVIRONMENT_BAD_SETUP',
      message: /returns-nothing/,
    })
    assert.equal('__leaked' in globalThis, false)
  })

  it('a name that is neither built in nor installed is VITEST_ENVIRONMENT_NOT_FOUND', () => {
    assert.throws(() => vitestEnvironmentRef('nope-not-here', {}, ROOT), {
      code: 'VITEST_ENVIRONMENT_NOT_FOUND',
    })
  })

  it('a path is resolved against the root', () => {
    const ref = vitestEnvironmentRef('./envs/mine.ts', {}, '/project')
    assert.equal(ref.options.module, '/project/envs/mine.ts')
    assert.equal(ref.export, 'vitestEnvironment')
  })

  it("without an options docblock a file naming the project's environment keeps its options", async () => {
    const base = vitestEnvironmentRef('happy-dom', { happyDOM: { width: 640 } }, ROOT)
    const ref = await vitestEnvironmentFor({
      name: 'happy-dom',
      options: null,
      rootDir: ROOT,
      testPath: 'x',
      base,
    })
    assert.deepEqual(ref.options.environmentOptions, { happyDOM: { width: 640 } })
  })

  it('an environment with only setupVM is refused (VITEST_ENVIRONMENT_SETUP_VM)', async () => {
    const environment = fromVitestEnvironment({ name: 'vm-only', setupVM: () => ({}) })
    await assert.rejects(async () => environment.setup({} as never, undefined), {
      code: 'VITEST_ENVIRONMENT_SETUP_VM',
    })
  })

  it("a module whose default is not an object gets Vitest 5.0.5's text", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-env-')))
    try {
      const module = join(root, 'bad.mjs')
      await writeFile(module, 'export default 1\n')
      await assert.rejects(
        async () =>
          vitestEnvironment.prepare?.({
            name: './bad.mjs',
            rootDir: root,
            module,
            environmentOptions: {},
          }),
        {
          name: 'TypeError',
          message: `Environment "./bad.mjs" is not a valid environment. Path "${module}" should export default object with a "setup" or/and "setupVM" method.`,
        },
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fromVitestEnvironment runs setup and teardown on the worker's global and restores it", async () => {
    const calls: string[] = []
    const environment = fromVitestEnvironment(
      {
        name: 'mine',
        setup(global, options) {
          calls.push(`setup ${JSON.stringify(options)}`)
          ;(global as { __mine?: number }).__mine = 1
          return { teardown: () => calls.push('teardown') }
        },
      },
      { mine: { a: 1 } },
    )
    const instance = await environment.setup({} as never, undefined)
    assert.equal((globalThis as { __mine?: number }).__mine, 1)
    await instance.teardown?.()
    assert.equal('__mine' in globalThis, false)
    assert.deepEqual(calls, ['setup {"mine":{"a":1}}', 'teardown'])
  })
})
