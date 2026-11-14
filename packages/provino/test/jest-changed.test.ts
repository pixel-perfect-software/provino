// T9.16: `provino jest`'s changed-file flags (`-o`, `--changedSince`, `--lastCommit`,
// `--changedFilesWithAncestor`, `--findRelatedTests`, `--onlyFailures`) against every `changed/*`
// golden recorded from Jest 30.5.2. Each fixture is written as the recorder writes it (its config
// in `.harness-out/`, which the repository leaves out), its `scm` steps run with the same hermetic
// git, its `before` runs go first, and the bin runs with the recorder's flags: the listed set, the
// kept lines and the exit code are Jest's. This is the evidence for the Jest dialect's
// `orchestrator.changedFiles` (T1.7): only Jest's provider passes it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
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

/** The harness's hermetic git (`internal/scm.ts`): the `-c` pairs, and as `GIT_CONFIG_*` for the bin. */
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'provino'],
  ['user.email', 'provino@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
  ['core.excludesFile', '/dev/null'],
  ['core.hooksPath', '/dev/null'],
]

function gitEnv(ceiling: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
    ...Object.fromEntries(
      GIT_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

function git(root: string, args: readonly string[]): void {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  execFileSync(
    'git',
    [...GIT_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...args],
    {
      cwd: root,
      env: { ...env, ...gitEnv(dirname(root)) },
      stdio: 'ignore',
    },
  )
}

async function runScm(root: string, steps: readonly ScmStep[]): Promise<void> {
  git(root, ['init', '-q', '--template='])
  await mkdir(join(root, '.git', 'info'), { recursive: true })
  await writeFile(
    join(root, '.git', 'info', 'exclude'),
    '.harness-out/\n.jest-cache/\n.vite/\nnode_modules/\n',
  )
  for (const step of steps) {
    if ('git' in step) git(root, step.git)
    else if ('commit' in step) {
      git(root, ['add', '-A'])
      git(root, [
        'commit',
        '-q',
        '--allow-empty',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        step.commit,
      ])
    } else if ('branch' in step) git(root, ['checkout', '-q', '-b', step.branch])
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
    assert.equal(IDS.length, 38)
  })
  for (const name of IDS) {
    it(`changed/${name}`, async () => {
      await check(await loadFixture(`changed/${name}`))
    })
  }
})
