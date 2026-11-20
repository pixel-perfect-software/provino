// B25f, T8.6: a Vitest project's environment under `provino vitest`, through the bin, held to the
// `env/vitest-*` goldens recorded from Vitest 5.0.5 (each test's status, and the run's outcome): the
// config's `environment` and `environmentOptions`, `--environment`, `--dom` (`cli/vitest-dom`), and
// the `@vitest-environment`/`@jest-environment` docblocks with `-options`. The project's
// `environment` goes through the dialect's `vitestEnvironmentRef`, as a docblock's does, not through
// `provino run`'s built-ins. jsdom, happy-dom and `@edge-runtime/vm` are the project's own libraries:
// each is linked into the project from `@provino/dialect-vitest`'s devDependencies.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { provinoVitest, type VitestFixture, withVitestFixture } from './vitest-recorded.ts'

const OUTPUT = '.harness-out/vitest.json'
const LIBRARIES = ['jsdom', 'happy-dom', '@edge-runtime/vm']
const DIALECT_MODULES = fileURLToPath(
  new URL('../../dialect-vitest/node_modules/', import.meta.url),
)

interface VitestJson {
  readonly testResults: readonly {
    readonly name: string
    readonly assertionResults: readonly {
      readonly ancestorTitles: readonly string[]
      readonly title: string
      readonly status: string
    }[]
  }[]
}

/** Links the environment libraries into the project's `node_modules`, as an install would put them. */
async function linkLibraries(root: string): Promise<void> {
  for (const name of LIBRARIES) {
    const target = join(root, 'node_modules', name)
    await mkdir(join(target, '..'), { recursive: true })
    await symlink(await realpath(join(DIALECT_MODULES, name)), target, 'dir')
  }
}

/** Each recorded file's tests as `[file, [[title path, status], …]]`, sorted by file. */
function recordedStatuses(fixture: VitestFixture): unknown[] {
  const golden = fixture.golden
  return (golden.files ?? [])
    .map((file) => [
      file.file,
      (file.tests ?? []).map((test) => [test.id.path.join(' > '), test.status]),
    ])
    .sort(byFile)
}

function reportedStatuses(root: string, json: VitestJson): unknown[] {
  return json.testResults
    .map((result) => [
      result.name.slice(root.length + 1),
      result.assertionResults.map((test) => [
        [...test.ancestorTitles, test.title].join(' > '),
        test.status,
      ]),
    ])
    .sort(byFile)
}

function byFile(a: unknown[], b: unknown[]): number {
  return String(a[0]).localeCompare(String(b[0]))
}

/** Runs the project with `extra` and holds every test's status and the exit code to the golden. */
async function holds(
  fixture: VitestFixture,
  root: string,
  extra: readonly string[] = [],
): Promise<void> {
  await linkLibraries(root)
  const ended = await provinoVitest(fixture, root, [
    ...extra,
    '--reporter=json',
    `--outputFile=${OUTPUT}`,
  ])
  const golden = fixture.golden
  const exitCode = fixture.golden.observed?.exitCode ?? (golden.success === true ? 0 : 1)
  assert.equal(ended.code, exitCode, ended.stderr)
  const json = JSON.parse(await readFile(join(root, OUTPUT), 'utf8')) as VitestJson
  assert.deepEqual(reportedStatuses(root, json), recordedStatuses(fixture), ended.stderr)
}

describe('provino vitest environments against Vitest 5.0.5 (T8.6)', () => {
  for (const id of [
    'env/vitest-jsdom',
    'env/vitest-happy-dom',
    'env/vitest-edge-runtime',
    'env/vitest-custom-package',
    'env/vitest-options',
    'env/vitest-docblock',
  ]) {
    it(id, () => withVitestFixture(id, (fixture, root) => holds(fixture, root)))
  }

  it('--environment happy-dom in place of the config key (env/vitest-happy-dom)', () =>
    withVitestFixture('env/vitest-happy-dom', async (fixture, root) => {
      // The command line's `environment` is the config's, so the config file loses its own.
      const file = join(root, 'vitest.config.ts')
      const text = await readFile(file, 'utf8')
      const config = JSON.parse(text.replace(/^export default /, '')) as {
        test: Record<string, unknown>
      }
      assert.equal(config.test.environment, 'happy-dom')
      delete config.test.environment
      await writeFile(file, `export default ${JSON.stringify(config, null, 2)}\n`)
      await holds(fixture, root, ['--environment=happy-dom'])
    }))

  it('--dom (cli/vitest-dom)', () =>
    withVitestFixture('cli/vitest-dom', (fixture, root) => holds(fixture, root)))

  it('an environment that is neither built in nor installed ends 1 with its message', () =>
    withVitestFixture('cli/vitest-env', async (fixture, root) => {
      const ended = await provinoVitest(fixture, root, ['--environment=provino-not-installed'])
      assert.equal(ended.code, 1)
      assert.match(
        ended.stderr,
        /^Error: Cannot find package 'vitest-environment-provino-not-installed'/m,
      )
    }))
})
