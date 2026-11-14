// T11.9 (B23a): `provino jest` with the reporters real projects name, beside Jest 30.5.2. Twenty small
// files run under `default`, `summary` (threshold 5), `github-actions`, jest-junit 17,
// jest-silent-reporter, jest-html-reporters, vscode-jest 6.4.4's own reporter and jest-sonar-reporter
// as `testResultsProcessor`, one worker, and every stream and report is compared with what Jest
// wrote (`cli/reporters-twenty`) byte for byte: the project's path is `<root>` and times are masked
// (the fixture's `mask`), nothing else.
//
// Not compared: the files jest-html-reporters and jest-sonar-reporter write. Both embed each
// failure's whole `.stack`, which for Jest holds Jest's own frames (`jest-circus/build/...:824:5`,
// by absolute path and line), and a Provino run has no such frames. jest-junit's `noStackTrace`
// drops them from its file, so that one is compared. The two reporters still run, and the test
// asserts that they wrote their files.
import assert from 'node:assert/strict'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const ID = 'cli/reporters-twenty'

/** Inside this package, so the reporters the config names resolve from its `node_modules`. */
const WORK = fileURLToPath(new URL('../.work/', import.meta.url))

describe('provino jest runs the third-party reporters as Jest 30.5.2 does', () => {
  it('cli/reporters-twenty: stderr, stdout, the exit code and jest-junit’s file, byte for byte', async () => {
    const fixture = await loadFixture(ID)
    const { run, env } = fixture.manifest
    assert.ok(run !== undefined)
    const observed = fixture.golden.observed
    assert.ok(observed !== undefined)
    const project = await materialize(fixture, { parent: WORK })
    try {
      // The recorder's own directory for the results file, which Jest's `--outputFile` doesn't make.
      await mkdir(join(project.root, '.harness-out'), { recursive: true })
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          '--json',
          '--outputFile=.harness-out/jest.json',
        ],
        {
          cwd: project.root,
          env: { CI: '1', NO_COLOR: '1', TZ: 'UTC', ...env },
          deadlineMs: 120_000,
        },
      )
      const roots = [project.root]
      const stream = (text: string): string =>
        observedText(text, { roots, keepLines: run.keepLines, mask: run.mask })
      assert.equal(ended.code, observed.exitCode)
      assert.equal(stream(ended.stdout), observed.stdout ?? '')
      assert.equal(stream(ended.stderr), observed.stderr)
      for (const [file, expected] of Object.entries(observed.files ?? {})) {
        const text = await readFile(join(project.root, file), 'utf8')
        assert.equal(observedText(text, { roots, mask: run.mask }), expected, file)
      }
      // The reporters whose files are not compared still ran.
      await access(join(project.root, 'test-report.xml'))
      await access(join(project.root, 'reports/html/report.html'))
    } finally {
      await project.dispose()
    }
  })
})
