import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { binScript, runCommand } from './exec.ts'
import { umbrellaEntries, WORKER_ENTRIES, workerRefs } from './umbrella.ts'
import { ROOT } from './workspace.ts'

describe('the umbrella names every module a worker is given by file (D21)', () => {
  test('each row is an entry file of the build, under worker/, with a source that exists', () => {
    const dir = join(ROOT, 'packages', 'provino')
    const entries = umbrellaEntries(dir)
    for (const [specifier, name] of Object.entries(WORKER_ENTRIES)) {
      assert.match(name, /^worker\/[a-z-]+$/, specifier)
      assert.ok(existsSync(join(dir, entries[name] ?? 'missing')), `${specifier}: ${entries[name]}`)
    }
    const names = Object.values(WORKER_ENTRIES)
    assert.equal(new Set(names).size, names.length)
  })

  test("the umbrella's own entries are its exports and its bin", () => {
    const entries = umbrellaEntries(join(ROOT, 'packages', 'provino'))
    assert.equal(entries.index, 'src/index.ts')
    assert.equal(entries.jest, 'src/jest.ts')
    assert.equal(entries.cli, 'src/cli.ts')
    assert.equal(entries['worker/jest-runtime'], '../dialect-jest/src/runtime/index.ts')
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

  test('a resolve whose specifier is not a literal fails the build: it could name any package', () => {
    for (const call of [
      'import.meta.resolve(name)',
      'import.meta.resolve(`@provino/${name}`)',
      "import.meta.resolve('@provino/' + name)",
      'import.meta.resolve(\n  name,\n)',
    ]) {
      assert.throws(
        () => hooks.transform.handler(`const a = ${call}\n`, '/x/a.ts'),
        /import\.meta\.resolve needs a string literal/,
        call,
      )
    }
  })

  test('a comment that names the call is not a call', () => {
    const source =
      '// the worker is found with import.meta.resolve(name)\n/**\n * import.meta.resolve(x)\n */\nexport const a = 1\n'
    assert.equal(hooks.transform.handler(source, '/x/a.ts'), null)
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
