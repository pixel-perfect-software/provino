// B25f: `vitestNodeDialect` end to end, in band (the inline pool: the files run in this process),
// ahead of `provino vitest` (B25g). A project with no config file is read with Vitest's defaults
// (`readVitestConfig`), resolved with the dialect, and run: a file that imports `vitest` (the served
// module, with the shipped `vi`), and one whose `@vitest-environment jsdom` docblock the dialect's
// resolver turns into `@provino/env-jsdom`.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { after, test } from 'node:test'
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
      ' * @vitest-environment jsdom',
      ' */',
      "import { expect, test } from 'vitest'",
      "test('the docblock gives a jsdom window', () => {",
      "  document.body.innerHTML = '<p>hi</p>'",
      "  expect(document.querySelector('p')?.textContent).toBe('hi')",
      '})',
      '',
    ].join('\n'),
  )
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
    files: { file: string; status: string; tests: { status: string }[] }[]
  }
  assert.equal(result.exitCode, 0, stderr.text())
  assert.deepEqual(
    run.files.map((file) => [file.file, file.status, file.tests.map((t) => t.status)]),
    [
      ['dom.test.ts', 'passed', ['passed']],
      ['vi.test.ts', 'passed', ['passed', 'passed']],
    ],
  )
})
