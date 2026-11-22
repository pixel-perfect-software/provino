// B27g2: the facts `dogfood.ts` shares, and the proof that no test file of a migrated package is lost
// between the two runners. The completeness test runs the built bin (turbo builds `provino` first,
// `tooling/packaging/turbo.json`) with a name filter that matches no test, so every file Provino
// discovers is imported and reported as skipped, and none runs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import {
  bootstrapFiles,
  isIncludedTestFile,
  migratedDirs,
  TEST_RUNNER,
  testScript,
} from './dogfood.ts'
import { scratchDir } from './test-support.ts'
import { ROOT } from './workspace.ts'

const BIN = join(ROOT, 'packages/provino/dist/cli.js')

/** Every `*.test.ts` a migrated package's config would consider, relative to the package. */
function testFilesOf(dir: string): string[] {
  const found: string[] = []
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (isIncludedTestFile(relative(dir, full).split('\\').join('/'))) found.push(full)
    }
  }
  walk(dir)
  return found.map((file) => relative(dir, file).split('\\').join('/')).sort()
}

describe('migratedDirs', () => {
  it('reads the root it is given, whatever the working directory', () => {
    const root = scratchDir('dogfood', {
      'packages/a/package.json': '{}',
      'packages/a/provino.config.ts': '',
      'packages/b/package.json': '{}',
      'tooling/c/package.json': '{}',
      'tooling/c/provino.config.ts': '',
      'packages/d/provino.config.ts': '',
    })
    assert.deepEqual(migratedDirs(root), ['packages/a', 'tooling/c'])
    assert.deepEqual(
      migratedDirs(ROOT).filter((dir) => dir === 'packages/policy'),
      ['packages/policy'],
    )
  })
})

describe('testScript', () => {
  it("is the runner alone, or the runner and node --test over the package's bootstrap files", () => {
    assert.equal(testScript(ROOT, 'packages/policy'), TEST_RUNNER)
    assert.match(
      testScript(ROOT, 'packages/lazy'),
      /^node \.\.\/\.\.\/packages\/provino\/dist\/cli\.js run && node --test --conditions=provino-source src\/api\.test\.ts src\/read\.test\.ts$/,
    )
  })
})

describe('every test file of a migrated package runs on exactly one runner', () => {
  it('what Provino discovers is every test file minus the bootstrap set', () => {
    assert.ok(existsSync(BIN), `${BIN} is missing: run pnpm build`)
    const staying = bootstrapFiles(ROOT)
    const dirs = migratedDirs(ROOT)
    assert.ok(dirs.length > 0, 'no migrated package found')
    for (const dir of dirs) {
      const packageDir = join(ROOT, dir)
      const own = staying
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1))
      const expected = testFilesOf(packageDir).filter((file) => !own.includes(file))
      const report = join(scratchDir('listing'), 'report.json')
      const ran = spawnSync(
        process.execPath,
        [BIN, 'run', '--reporter', 'json', '--outputFile', report, '-t', 'NO TEST HAS THIS NAME'],
        { cwd: packageDir, encoding: 'utf8' },
      )
      const parsed = JSON.parse(readFileSync(report, 'utf8')) as { files: { file: string }[] }
      const discovered = parsed.files.map((entry) => entry.file).sort()
      assert.deepEqual(discovered, expected, `${dir}: Provino's files differ (exit ${ran.status})`)
    }
  })
})
