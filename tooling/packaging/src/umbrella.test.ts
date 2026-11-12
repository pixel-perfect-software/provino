import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { binScript, runCommand } from './exec.ts'
import { WORKER_ENTRIES, workerRefs } from './umbrella.ts'
import { ROOT } from './workspace.ts'

/** The files of `dir` below `src/`, recursively, that aren't tests. */
function sources(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !/\.test(-d)?\.ts$/.test(entry.name) && entry.name !== 'test-support.ts')
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('the umbrella names every module a worker is given by file (D21)', () => {
  test('WORKER_ENTRIES covers each import.meta.resolve of a bundled @provino package', () => {
    const bundled = [
      'config',
      'core',
      'dialect-jest',
      'env-jsdom',
      'env-node',
      'env-shared',
      'expect',
      'loader',
      'mock',
      'orchestrator',
      'policy',
      'reporters',
      'resolver',
      'rpc',
      'snapshot',
      'timers',
      'transform',
      'types',
    ]
    const call = /import\.meta\.resolve\(\s*(?:'(@provino\/[^']+)'|"(@provino\/[^"]+)")\s*\)/g
    const found = new Set<string>()
    for (const name of bundled) {
      for (const file of sources(join(ROOT, 'packages', name, 'src'))) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
          for (const match of line.matchAll(call)) found.add(match[1] ?? match[2] ?? '')
        }
        // A call split over lines: the specifier is on the next line.
        for (const match of readFileSync(file, 'utf8').matchAll(
          /^[^/*\n]*import\.meta\.resolve\(\s*\n\s*'(@provino\/[^']+)'/gm,
        )) {
          found.add(match[1] ?? '')
        }
      }
    }
    assert.ok(found.size >= 4, [...found].join(', '))
    for (const specifier of found) {
      // The Vitest dialect isn't bundled in the umbrella, so its refs are never rewritten.
      if (specifier.startsWith('@provino/dialect-vitest')) continue
      assert.ok(Object.hasOwn(WORKER_ENTRIES, specifier), `${specifier} has no WORKER_ENTRIES row`)
    }
  })

  test('every resolve in shipped code names its specifier as a literal, which the plugin can read', () => {
    const shipped = [
      'config',
      'core',
      'dialect-jest',
      'env-jsdom',
      'env-node',
      'env-shared',
      'expect',
      'loader',
      'mock',
      'orchestrator',
      'policy',
      'reporters',
      'resolver',
      'rpc',
      'snapshot',
      'timers',
      'transform',
      'types',
    ]
    for (const name of shipped) {
      for (const file of sources(join(ROOT, 'packages', name, 'src'))) {
        const code = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
          .join('\n')
        for (const match of code.matchAll(/import\.meta\.resolve\(\s*([^)]{0,3})/g)) {
          assert.match(
            match[1] ?? '',
            /^(?:[\s'"`]|$)/,
            `${file}: import.meta.resolve with a non-literal argument`,
          )
        }
      }
    }
  })

  test('each row is an entry file of the build, under worker/', () => {
    for (const [specifier, entry] of Object.entries(WORKER_ENTRIES)) {
      assert.match(entry.name, /^worker\/[a-z-]+$/, specifier)
      assert.match(entry.source, /^\.\.\/[a-z-]+\/src\/.+\.ts$/, specifier)
    }
    const names = Object.values(WORKER_ENTRIES).map((entry) => entry.name)
    assert.equal(new Set(names).size, names.length)
  })
})

describe('the worker-ref plugin', () => {
  const hooks = (workerRefs() as readonly unknown[])[0] as {
    transform: { handler: (code: string, id: string) => { code: string } | null }
    renderChunk: (code: string, chunk: { fileName: string }) => { code: string } | null
  }

  test('writes each resolve as a path to that entry, relative to the chunk that holds it', () => {
    const source = [
      "const a = import.meta.resolve('@provino/orchestrator/worker/main')",
      'const b = import.meta.resolve(\n  "@provino/dialect-jest/runtime",\n)',
      "const c = import.meta.resolve('es-module-lexer')",
      '',
    ].join('\n')
    const marked = hooks.transform.handler(source, '/x/a.ts')
    assert.ok(marked !== null)
    assert.match(marked.code, /es-module-lexer/, 'a third-party resolve is left alone')
    const inRoot = hooks.renderChunk(marked.code, { fileName: 'shared.js' })
    assert.match(inRoot?.code ?? '', /new URL\("\.\/worker\/main\.js", import\.meta\.url\)\.href/)
    assert.match(inRoot?.code ?? '', /new URL\("\.\/worker\/jest-runtime\.js", import\.meta\.url\)/)
    const inWorker = hooks.renderChunk(marked.code, { fileName: 'worker/jest-runtime.js' })
    assert.match(inWorker?.code ?? '', /new URL\("\.\/main\.js", import\.meta\.url\)\.href/)
    assert.match(inWorker?.code ?? '', /new URL\("\.\/jest-runtime\.js", import\.meta\.url\)/)
  })

  test('a @provino specifier the table does not know fails the build', () => {
    assert.throws(
      () => hooks.transform.handler("import.meta.resolve('@provino/mock')", '/x/a.ts'),
      /names a package the umbrella doesn't bundle as an entry/,
    )
  })

  test('leaves a module with no resolve call as it is', () => {
    assert.equal(hooks.transform.handler('export const a = 1', '/x/a.ts'), null)
    assert.equal(hooks.renderChunk('export const a = 1', { fileName: 'a.js' }), null)
  })
})

describe('knip gate (T1.6)', () => {
  /** A scratch project with an entry file and `extra` files, and knip's own exit status. */
  function knip(extra: Readonly<Record<string, string>>): {
    status: number | null
    output: string
  } {
    const dir = mkdtempSync(join(tmpdir(), 'knip-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'planted', version: '1.0.0', type: 'module', main: 'index.ts' }),
    )
    writeFileSync(
      join(dir, 'knip.json'),
      JSON.stringify({ entry: ['index.ts'], project: ['*.ts'] }),
    )
    writeFileSync(
      join(dir, 'index.ts'),
      "import { used } from './used.ts'\nexport const a = used\n",
    )
    writeFileSync(join(dir, 'used.ts'), 'export const used = 1\n')
    for (const [file, text] of Object.entries(extra)) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    return runCommand(process.execPath, [binScript('knip', 'knip'), '--no-progress'], {
      cwd: dir,
      timeoutMs: 120_000,
    })
  }

  test('a clean project passes', () => {
    const { status, output } = knip({})
    assert.equal(status, 0, output)
  })

  test('an unused file fails, naming it', () => {
    const { status, output } = knip({ 'orphan.ts': 'export const orphan = 1\n' })
    assert.notEqual(status, 0, output)
    assert.match(output, /Unused files[\s\S]*orphan\.ts/)
  })

  test('an import of a package the package.json does not list fails', () => {
    const { status, output } = knip({ 'index.ts': "import 'not-declared'\nexport const a = 1\n" })
    assert.notEqual(status, 0, output)
    assert.match(output, /not-declared/)
  })
})
