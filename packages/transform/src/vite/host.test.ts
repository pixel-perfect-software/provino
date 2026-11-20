import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ViteHostError } from './errors.ts'
import { passesFilter } from './filter.ts'
import { createViteHost, pluginCodeHash, type VitePlugin, viteHostFingerprint } from './host.ts'
import { fixturePlugins } from './test-plugins.ts'

const resolveFile = (specifier: string): string | null =>
  ['', '.ts', '.js'].map((ext) => specifier + ext).find((path) => existsSync(path)) ?? null

// Each test plugin is written inline as the plugin shape the host reads.
const plugin = (value: Record<string, unknown> & { readonly name: string }): VitePlugin =>
  value as unknown as VitePlugin

// What the inline plugins below call on their `this`.
interface TestContext {
  parse(code: string): { readonly body: readonly unknown[] }
  warn(message: string): void
  addWatchFile(file: string): void
  getCombinedSourcemap(): { readonly version: number }
  getModuleInfo(id: string): unknown
  readonly environment: { readonly name: string }
}

describe('the four plugins the plan names', () => {
  test('@vitejs/plugin-vue compiles a single-file component', async () => {
    const { root, plugins } = await fixturePlugins('vue')
    const host = createViteHost({ root, plugins })
    await host.buildStart()
    const file = join(root, 'App.vue')
    const out = await host.transform(readFileSync(file, 'utf8'), file)
    assert.ok(out !== null)
    assert.match(out.code, /_sfc_main/)
    assert.match(out.code, /_sfc_ssrRender/)
    assert.deepEqual(host.pluginNames, ['vite:vue'])
  })

  test('@sveltejs/vite-plugin-svelte compiles a component', async () => {
    const { root, plugins } = await fixturePlugins('svelte')
    const host = createViteHost({ root, plugins })
    await host.buildStart()
    const file = join(root, 'Counter.svelte')
    const out = await host.transform(readFileSync(file, 'utf8'), file)
    assert.ok(out !== null)
    assert.match(out.code, /function Counter\(/)
  })

  test('vite-tsconfig-paths maps an alias through this.resolve', async () => {
    const { root, plugins } = await fixturePlugins('tsconfig-paths')
    const host = createViteHost({ root, plugins, resolve: resolveFile })
    await host.buildStart()
    const found = await host.resolveId('@/util', join(root, 'src/main.ts'))
    assert.deepEqual(found, { type: 'file', path: join(root, 'src/util.ts') })
    assert.equal(await host.resolveId('./util', join(root, 'src/main.ts')), null)
  })

  test('vite-plugin-svgr loads an svg as a component (it picks Oxc from the context)', async () => {
    const { root, plugins } = await fixturePlugins('svgr')
    const host = createViteHost({ root, plugins })
    const out = await host.load(join(root, 'logo.svg?react'))
    assert.ok(out !== null)
    assert.match(out.code, /SvgLogo/)
    assert.equal(await host.load(join(root, 'logo.svg')), null)
  })
})

describe('virtual modules and ids', () => {
  const virtual = plugin({
    name: 'virtual',
    resolveId: (source: string) => (source === 'virtual:answer' ? '\0virtual:answer' : null),
    load: (id: string) => (id === '\0virtual:answer' ? 'export default 42' : null),
  })

  test('a \\0 id is a virtual module the host owns, and the host loads it', async () => {
    const host = createViteHost({ root: '/p', plugins: [virtual] })
    assert.deepEqual(await host.resolveId('virtual:answer', '/p/a.ts'), {
      type: 'virtual',
      id: '\0virtual:answer',
      owner: 'vite-host',
    })
    assert.equal((await host.load('\0virtual:answer'))?.code, 'export default 42')
    assert.equal(await host.resolveId('./other', '/p/a.ts'), null)
  })

  test('an absolute id with a query is virtual, a plain absolute id is a file', async () => {
    const host = createViteHost({
      root: '/p',
      plugins: [
        plugin({
          name: 'ids',
          resolveId: (source: string) =>
            source.startsWith('q:') ? `/p/x.vue?${source}` : '/p/x.ts',
        }),
      ],
    })
    assert.equal((await host.resolveId('q:1', undefined))?.type, 'virtual')
    assert.deepEqual(await host.resolveId('plain', undefined), { type: 'file', path: '/p/x.ts' })
  })
})

describe('hooks', () => {
  test('a filter keeps the hook from running', async () => {
    const seen: string[] = []
    const host = createViteHost({
      root: '/p',
      plugins: [
        plugin({
          name: 'filtered',
          transform: {
            filter: { id: /\.vue$/ },
            handler(code: string, id: string) {
              seen.push(id)
              return code.toUpperCase()
            },
          },
        }),
      ],
    })
    assert.equal(await host.transform('a', '/p/a.ts'), null)
    assert.equal((await host.transform('a', '/p/a.vue'))?.code, 'A')
    assert.deepEqual(seen, ['/p/a.vue'])
  })

  test('plugins run pre, normal, post; transforms thread the code', async () => {
    const step = (name: string, enforce?: 'pre' | 'post'): VitePlugin =>
      plugin({
        name,
        ...(enforce === undefined ? {} : { enforce }),
        transform: (code: string) => `${code}${name}`,
      })
    const host = createViteHost({
      root: '/p',
      plugins: [step('b'), step('c', 'post'), step('a', 'pre')],
    })
    assert.deepEqual(host.pluginNames, ['a', 'b', 'c'])
    assert.equal((await host.transform('>', '/p/x.ts'))?.code, '>abc')
  })

  test('the context carries parse, warn, addWatchFile, environment and getCombinedSourcemap', async () => {
    const warnings: string[] = []
    const host = createViteHost({
      root: '/p',
      warn: (message) => warnings.push(message),
      plugins: [
        plugin({
          name: 'ctx',
          transform(this: TestContext, code: string) {
            const program = this.parse(code)
            this.warn('careful')
            this.addWatchFile('/p/dep.txt')
            const map = this.getCombinedSourcemap()
            return `${program.body.length}:${this.environment.name}:${map.version}`
          },
        }),
      ],
    })
    assert.equal((await host.transform('a(); b()', '/p/x.js'))?.code, '2:ssr:3')
    assert.deepEqual(warnings, ['[ctx] careful'])
    assert.deepEqual([...host.watchFiles], ['/p/dep.txt'])
  })

  test('a throwing hook is VITE_PLUGIN_FAILED naming the plugin, with the cause', async () => {
    const boom = new Error('boom')
    const host = createViteHost({
      root: '/p',
      plugins: [
        plugin({
          name: 'thrower',
          transform: () => {
            throw boom
          },
        }),
      ],
    })
    await assert.rejects(host.transform('a', '/p/x.ts'), (error: unknown) => {
      assert.ok(error instanceof ViteHostError)
      assert.equal(error.code, 'VITE_PLUGIN_FAILED')
      assert.equal(error.plugin, 'thrower')
      assert.equal(error.cause, boom)
      return true
    })
  })
})

describe('what a test run has no use for', () => {
  test('this.getModuleInfo throws VITE_HOOK_UNSUPPORTED naming the plugin', async () => {
    const host = createViteHost({
      root: '/p',
      plugins: [
        plugin({
          name: 'graph-reader',
          transform(this: TestContext) {
            return String(this.getModuleInfo('/p/x.ts'))
          },
        }),
      ],
    })
    await assert.rejects(host.transform('a', '/p/x.ts'), (error: unknown) => {
      assert.ok(error instanceof ViteHostError)
      assert.equal(error.code, 'VITE_HOOK_UNSUPPORTED')
      assert.equal(error.plugin, 'graph-reader')
      assert.match(error.message, /graph-reader.*this\.getModuleInfo/)
      return true
    })
  })

  for (const hook of ['configureServer', 'handleHotUpdate', 'transformIndexHtml']) {
    test(`a strict host refuses a plugin with ${hook}; a default host leaves it uncalled`, () => {
      const called: string[] = []
      const withHook = plugin({ name: 'dev-only', [hook]: () => called.push(hook) })
      assert.throws(
        () => createViteHost({ root: '/p', plugins: [withHook], strict: true }),
        (error: unknown) =>
          error instanceof ViteHostError &&
          error.code === 'VITE_HOOK_UNSUPPORTED' &&
          error.plugin === 'dev-only' &&
          error.message.includes(hook),
      )
      createViteHost({ root: '/p', plugins: [withHook] })
      assert.deepEqual(called, [])
    })
  }

  test('@vitejs/plugin-react is skipped by default, since Oxc does JSX', () => {
    const react = plugin({ name: 'vite:react-babel', transform: (code: string) => `${code}!` })
    assert.deepEqual(createViteHost({ root: '/p', plugins: [react] }).skipped, ['vite:react-babel'])
    const kept = createViteHost({ root: '/p', plugins: [react], includeReact: true })
    assert.deepEqual(kept.pluginNames, ['vite:react-babel'])
  })
})

describe('the cache fingerprint', () => {
  const identity = { name: 'p', version: '1.0.0', codeHash: 'h' }
  test('a plugin version, its code or the config file each move it', () => {
    const base = viteHostFingerprint([identity], 'c1')
    assert.equal(viteHostFingerprint([identity], 'c1'), base)
    assert.notEqual(viteHostFingerprint([{ ...identity, version: '1.0.1' }], 'c1'), base)
    assert.notEqual(viteHostFingerprint([{ ...identity, codeHash: 'h2' }], 'c1'), base)
    assert.notEqual(viteHostFingerprint([identity], 'c2'), base)
    assert.notEqual(viteHostFingerprint([], 'c1'), base)
  })

  test('pluginCodeHash follows the hook text', () => {
    const a = plugin({ name: 'p', transform: (code: string) => code })
    const b = plugin({ name: 'p', transform: (code: string) => `${code} ` })
    assert.equal(pluginCodeHash(a), pluginCodeHash(a))
    assert.notEqual(pluginCodeHash(a), pluginCodeHash(b))
  })
})

describe('hook filters', () => {
  test('regular expressions, globs, lists and include/exclude', () => {
    assert.equal(passesFilter(undefined, 'x'), true)
    assert.equal(passesFilter(/\.vue$/, '/a/b.vue'), true)
    assert.equal(passesFilter(/\.vue$/, '/a/b.ts'), false)
    assert.equal(passesFilter('**/*.svg?react', '/a/b.svg?react'), true)
    assert.equal(passesFilter('*.ts', '/a/b.ts'), false)
    assert.equal(passesFilter(['/exact', /y$/], '/exact'), true)
    assert.equal(passesFilter({ include: /\.ts$/, exclude: /\.d\.ts$/ }, '/a.d.ts'), false)
    assert.equal(passesFilter({ include: /\.ts$/, exclude: /\.d\.ts$/ }, '/a.ts'), true)
    assert.equal(passesFilter({ exclude: /node_modules/ }, '/a.ts'), true)
  })
})
