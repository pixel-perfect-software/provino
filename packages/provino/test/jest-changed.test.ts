// T9.16: `provino jest`'s changed-file flags (`-o`, `--changedSince`, `--lastCommit`,
// `--changedFilesWithAncestor`, `--findRelatedTests`, `--onlyFailures`) against every `changed/*`
// golden recorded from Jest 30.5.2. Each fixture is written as the recorder writes it (its config
// in `.harness-out/`, which the repository leaves out), its `scm` steps run with the same hermetic
// git, its `before` runs go first, and the bin runs with the recorder's flags: the listed set, the
// kept lines and the exit code are Jest's. This is the evidence for the Jest dialect's
// `orchestrator.changedFiles` (T1.7): only Jest's provider passes it.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'provino'
import { commitAll, git, gitEnv, initRepo } from './hermetic-git.ts'
import { FIXTURES, loadFixture, materialize, type RecordedFixture, underRoot } from './recorded.ts'
import { spawnCli, withoutNodeNoise } from './support.ts'

/** One step of a fixture's `scm` (the harness's `ScmStep`). */
type ScmStep =
  | { readonly git: readonly string[] }
  | { readonly commit: string }
  | { readonly branch: string }
  | { readonly checkout: string }
  | { readonly write: Readonly<Record<string, string>> }
  | { readonly remove: readonly string[] }

interface ChangedManifest {
  readonly scm?: { readonly steps: readonly ScmStep[] }
  readonly before?: readonly { readonly argv: readonly string[] }[]
  readonly run?: {
    readonly argv?: { readonly jest?: readonly string[] }
    readonly capture: readonly string[]
    readonly keepLines?: string
    readonly emptyStreams?: readonly string[]
  }
}

async function runScm(root: string, steps: readonly ScmStep[]): Promise<void> {
  await initRepo(root)
  for (const step of steps) {
    if ('git' in step) git(root, step.git)
    else if ('commit' in step) commitAll(root, step.commit)
    else if ('branch' in step) git(root, ['checkout', '-q', '-b', step.branch])
    else if ('checkout' in step) git(root, ['checkout', '-q', step.checkout])
    else if ('write' in step) {
      for (const [file, text] of Object.entries(step.write)) {
        await mkdir(dirname(join(root, file)), { recursive: true })
        await writeFile(join(root, file), text)
      }
    } else
      for (const file of step.remove) await rm(join(root, file), { recursive: true, force: true })
  }
}

/** The recorder's normalization of a kept line that this compares: the durations go. */
function normalized(line: string): string {
  return line.replaceAll(/ \(\d+(?:\.\d+)? m?s\)/g, '')
}

function keptLines(text: string, pattern: string | undefined): string {
  const keep = pattern === undefined ? undefined : new RegExp(pattern)
  return text
    .split('\n')
    .filter((line) => keep === undefined || keep.test(line))
    .map(normalized)
    .join('\n')
}

async function check(fixture: RecordedFixture): Promise<void> {
  const manifest = fixture.manifest as RecordedFixture['manifest'] & ChangedManifest
  const expected = fixture.golden.observed
  assert.ok(expected !== undefined, 'the golden records a black-box run')
  const project = await materialize(fixture)
  const { root } = project
  try {
    // The recorder's config is outside the tree git sees.
    const outDir = join(root, '.harness-out')
    await mkdir(outDir)
    const config = join(outDir, 'jest.config.json')
    await rename(join(root, 'jest.config.json'), config)
    if (manifest.scm !== undefined) await runScm(root, manifest.scm.steps)
    const outputFile = join(outDir, 'jest.json')
    const base = ['jest', '--ci', '--json', `--outputFile=${outputFile}`, '--config', config]
    const env = { CI: '1', NO_COLOR: '1', ...gitEnv(dirname(root)) }
    for (const earlier of manifest.before ?? []) {
      const ended = await spawnCli([...base, ...earlier.argv], { cwd: root, env })
      assert.equal(ended.signal, null, 'the "before" run exited')
      await rm(outputFile, { force: true })
    }
    const ended = await spawnCli([...base, ...(manifest.run?.argv?.jest ?? [])], { cwd: root, env })
    assert.equal(ended.signal, null, 'it exited, it was not killed')
    const stderr = underRoot(withoutNodeNoise(ended.stderr), root)
    assert.equal(ended.code, expected.exitCode, stderr)
    const keep = manifest.run?.keepLines
    if (expected.stderr !== undefined) {
      assert.equal(keptLines(stderr, keep), expected.stderr, stderr)
    }
    if (expected.stdout !== undefined) {
      assert.equal(keptLines(underRoot(ended.stdout, root), keep), expected.stdout)
    }
    for (const [file, text] of Object.entries(expected.files ?? {})) {
      const written = await readFile(join(root, file), 'utf8').catch(() => null)
      if (text === null) {
        assert.equal(written, null, file)
        continue
      }
      assert.ok(written !== null, `${file} was written:\n${stderr}`)
      const list = (JSON.parse(written) as string[]).map((path) => underRoot(path, root)).sort()
      assert.equal(list.join('\n'), text, `${file}:\n${stderr}`)
    }
  } finally {
    await project.dispose()
  }
}

const IDS = (await readdir(join(FIXTURES, 'changed'))).sort()

describe('provino jest against the changed/* goldens of Jest 30.5.2', () => {
  it('reads every fixture', () => {
    assert.equal(IDS.length, 39)
  })
  for (const name of IDS) {
    it(`changed/${name}`, async () => {
      await check(await loadFixture(`changed/${name}`))
    })
  }
})
