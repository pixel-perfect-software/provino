// B23c Phase 6: `provino jest --coverage` with the changed-file flags, against the reports real
// Jest 30.5.2 wrote for the same repository (`coverage/only-changed`, `only-changed-untested`,
// `find-related`). `-o` restricts coverage to the changed files and the sources the changed test
// files import (runJest.ts L403-L421, `shouldInstrument` L111-L118); `--findRelatedTests` does
// not (`SearchResult.collectCoverageFrom` is never read in 30.5.2). Each fixture is built as the
// recorder builds it (config in `.harness-out/`, which the repository leaves out, then its `scm`
// steps with the hermetic git), so the working tree has the same changes.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { commitAll, gitEnv, initRepo } from './hermetic-git.ts'
import { type Json, normalizedJson, observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

type ScmStep = { readonly commit: string } | { readonly write: Readonly<Record<string, string>> }

interface Scm {
  readonly scm?: { readonly steps: readonly ScmStep[] }
}

const RECORDER_ENV = { CI: '1', NO_COLOR: '1', COLUMNS: '', GITHUB_ACTIONS: '' }

async function runScm(root: string, steps: readonly ScmStep[]): Promise<void> {
  await initRepo(root)
  for (const step of steps) {
    if ('commit' in step) commitAll(root, step.commit)
    else {
      for (const [file, text] of Object.entries(step.write)) {
        await mkdir(dirname(join(root, file)), { recursive: true })
        await writeFile(join(root, file), text)
      }
    }
  }
}

async function check(id: string): Promise<void> {
  const fixture = await loadFixture(id)
  const manifest = fixture.manifest as typeof fixture.manifest & Scm
  const golden = fixture.golden.observed
  assert.ok(golden !== undefined, 'the golden records a black-box run')
  assert.ok(manifest.scm !== undefined, 'the fixture has scm steps')
  const project = await materialize(fixture)
  const { root } = project
  try {
    const outDir = join(root, '.harness-out')
    await mkdir(outDir)
    const config = join(outDir, 'jest.config.json')
    await rename(join(root, 'jest.config.json'), config)
    await runScm(root, manifest.scm.steps)
    const ended = await spawnCli(
      [
        'jest',
        `--config=${config}`,
        '--ci',
        '--json',
        `--outputFile=${join(outDir, 'jest.json')}`,
        ...(manifest.run?.argv?.jest ?? []),
      ],
      { cwd: root, env: { ...RECORDER_ENV, ...gitEnv(dirname(root)) } },
    )
    assert.equal(ended.code, golden.exitCode, ended.stderr)
    assert.equal(
      observedText(ended.stdout, { roots: [root], mask: manifest.run?.mask }),
      golden.stdout,
    )
    const json = async (path: string): Promise<Json | null> =>
      existsSync(join(root, path))
        ? normalizedJson(JSON.parse(await readFile(join(root, path), 'utf8')) as Json, {
            roots: [root],
            timeKeys: [],
            maskKeys: manifest.run?.maskKeys,
            mask: manifest.run?.mask,
          })
        : null
    // The summary, per file and in total.
    assert.deepEqual(
      await json('coverage/coverage-summary.json'),
      golden.json?.['coverage/coverage-summary.json'],
    )
    // The final map: the same files (the keys), each with Jest's counters and maps.
    const final = await json('coverage/coverage-final.json')
    const expected = golden.json?.['coverage/coverage-final.json']
    assert.deepEqual(Object.keys(final as object).sort(), Object.keys(expected as object).sort())
    // Istanbul's per-file `hash` is a digest of the work directory's path: masked by key.
    assert.deepEqual(final, expected)
  } finally {
    await project.dispose()
  }
}

describe('provino jest --coverage with the changed-file flags writes the reports Jest 30.5.2 wrote', () => {
  it('-o: the changed source and the sources a changed test imports, not the other loaded ones (coverage/only-changed)', async () => {
    await check('coverage/only-changed')
  })

  it('-o with collectCoverageFrom: an untested changed file is at zero, an untested unchanged one is left out (coverage/only-changed-untested)', async () => {
    await check('coverage/only-changed-untested')
  })

  it('--findRelatedTests does not restrict coverage: every collectCoverageFrom file is counted (coverage/find-related)', async () => {
    await check('coverage/find-related')
  })
})
