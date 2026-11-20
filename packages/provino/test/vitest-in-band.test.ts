// B25f: `vitestNodeDialect` end to end, in band (the inline pool: the files run in this process),
// ahead of `provino vitest` (B25g). A project with no config file is read with Vitest's defaults
// (`readVitestConfig`), resolved with the dialect, and run: a file that imports `vitest` (the served
// module, with the shipped `vi`), and one whose environment docblock (jsdom) the dialect's
// resolver turns into `@provino/env-jsdom`. knip reads an environment pragma as a dependency on the
// package it names, so the pragma below is built from two parts.
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveNeutralProject } from '@provino/config'
import { readVitestConfig, vitestNodeDialect } from '@provino/dialect-vitest/node'

/** `executeProject` and the built-in environments, loaded by URL (see `projects.test.ts`). */
const { executeProject } = (await import(
  new URL('../src/internal/execute.ts', import.meta.url).href
)) as {
  executeProject(options: {
    project: unknown
    cwd: string
    stdout: Writable
    stderr: Writable
    env: Record<string, string | undefined>
    reporters: readonly (readonly ['normalized-json', { outputFile: string }])[]
    pool: { kind: 'inline' }
    cache: false
  }): Promise<{ exitCode: number }>
}
const { ENVIRONMENTS } = (await import(
  new URL('../src/internal/built-ins.ts', import.meta.url).href
)) as { ENVIRONMENTS: Parameters<typeof resolveNeutralProject>[1]['environments'] }

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A sink that keeps what it is given. */
function collector(): { readonly stream: Writable; text(): string } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(chunk: unknown, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    }),
    text: () => chunks.join(''),
  }
}

/** Reads the project at `root` with Vitest's defaults, resolves it with the dialect and runs it in band. */
async function runInBand(root: string): Promise<{
  readonly result: { readonly exitCode: number }
  readonly run: {
    files: { file: string; status: string; tests: { id: { path: string[] }; status: string }[] }[]
  }
  readonly stderr: { text(): string }
}> {
  const read = await readVitestConfig({ cwd: root })
  assert.equal(read.projects.length, 1)
  const [neutral] = read.projects
  assert.ok(neutral)
  const project = await resolveNeutralProject(neutral, {
    dialect: vitestNodeDialect,
    environments: ENVIRONMENTS,
    ci: true,
  })
  const outputFile = join(root, 'normalized.json')
  const stdout = collector()
  const stderr = collector()
  const result = await executeProject({
    project,
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { CI: '1' },
    reporters: [['normalized-json', { outputFile }]],
    pool: { kind: 'inline' },
    cache: false,
  })
  const run = JSON.parse(await readFile(outputFile, 'utf8')) as {
    files: { file: string; status: string; tests: { id: { path: string[] }; status: string }[] }[]
  }
  return { result, run, stderr }
}

test('a Vitest project runs in band through vitestNodeDialect', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-smoke-')))
  made.push(root)
  await writeFile(join(root, 'package.json'), '{"type": "module"}\n')
  await writeFile(
    join(root, 'vi.test.ts'),
    [
      "import { expect, test, vi } from 'vitest'",
      "test('vi.fn records its calls', () => {",
      '  const f = vi.fn((x: number) => x * 2)',
      '  expect(f(2)).toBe(4)',
      '  expect(f).toHaveBeenCalledWith(2)',
      '})',
      "test('there is no document', () => {",
      "  expect(typeof document).toBe('undefined')",
      '})',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(root, 'dom.test.ts'),
    [
      '/**',
      ` * @${'vitest-environment'} jsdom`,
      ' */',
      "import { expect, test } from 'vitest'",
      "test('the docblock gives a jsdom window', () => {",
      "  document.body.innerHTML = '<p>hi</p>'",
      "  expect(document.querySelector('p')?.textContent).toBe('hi')",
      '})',
      '',
    ].join('\n'),
  )
  const { result, run, stderr } = await runInBand(root)
  assert.equal(result.exitCode, 0, stderr.text())
  assert.deepEqual(
    run.files.map((file) => [file.file, file.status, file.tests.map((t) => t.status)]),
    [
      ['dom.test.ts', 'passed', ['passed']],
      ['vi.test.ts', 'passed', ['passed', 'passed']],
    ],
  )
})

// D96's Vitest value (module/vitest-require-cache): a test file's `createRequire(import.meta.url)`
// is Node's, whose cache is the live one (deleting an entry evaluates the file again). No
// `ModulePolicy` key for `require.cache` exists yet (D96), so the golden is held here, against
// what the dialect does in band.
test('require.cache under the Vitest dialect is what Vitest 5.0.5 recorded (module/vitest-require-cache)', async () => {
  const fixture = fileURLToPath(
    new URL('../../harness/fixtures/module/vitest-require-cache/', import.meta.url),
  )
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-require-cache-')))
  made.push(root)
  await writeFile(join(root, 'package.json'), '{"type": "module"}\n')
  // The recorder's Vitest config: globals on (`internal/runner-config.ts`).
  await writeFile(join(root, 'vitest.config.mjs'), 'export default { test: { globals: true } }\n')
  const testFile = 'vitest-require-cache.vitest.test.ts'
  await Promise.all(
    ['counter.cjs', testFile].map((name) => copyFile(join(fixture, name), join(root, name))),
  )
  const golden = JSON.parse(
    await readFile(join(fixture, '__goldens__', 'vitest.json'), 'utf8'),
  ) as {
    files: { file: string; tests: { id: { path: string[] }; status: string }[] }[]
  }
  const { run, stderr } = await runInBand(root)
  const statuses = (files: typeof golden.files) =>
    files.map((file) => [file.file, file.tests.map((t) => [t.id.path.join(' > '), t.status])])
  assert.deepEqual(statuses(run.files), statuses(golden.files), stderr.text())
})
