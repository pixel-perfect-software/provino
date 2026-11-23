// T9.16: the hg and Sapling adapters against the real jest-changed-files 30.5.1's (D27). Neither
// tool is installed here or on CI (Gaps 8), so a fake `hg` and a fake `sl` on PATH log every call
// (the tool, its directory, HGPLAIN and the arguments) and answer `root` and `status`; both
// providers run over them, and the calls and the files must be the same.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChangedFilesOptions } from '@provino/types'
import { afterAll, beforeAll, test } from 'provino'
import { jestChangedFiles } from './index.ts'

interface RealChangedFiles {
  getChangedFilesForRoots(
    roots: string[],
    options: { changedSince?: string; lastCommit?: boolean; withAncestor?: boolean },
  ): Promise<{ changedFiles: Set<string>; repos: Record<'git' | 'hg' | 'sl', Set<string>> }>
}

const core = createRequire(fileURLToPath(import.meta.resolve('jest-cli'))).resolve('@jest/core')
/** Loaded once PATH holds the fakes: hg.ts and sl.ts copy `process.env` when they load. */
let real: RealChangedFiles

/** The fake: logs a line, then `root` prints the repository (or, as the locomotive, an escape and waits), `status` two files. */
const FAKE = `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$(basename "$0")" "$PWD" "$HGPLAIN" "$*" >> "$PROVINO_FAKE_LOG"
case "$1" in
  root)
    if [ -n "$PROVINO_FAKE_LOCOMOTIVE" ] && [ "$(basename "$0")" = sl ]; then
      printf '\\033[0m choo choo'
      exec sleep 30
    fi
    printf '%s\\n' "$PROVINO_FAKE_ROOT" ;;
  status) printf 'a.ts\\nsrc/b.ts\\n' ;;
esac
`

let base = ''
let log = ''
let root = ''
const saved = { ...process.env }

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'provino-hg-')))
  const bin = join(base, 'bin')
  await mkdir(bin)
  for (const tool of ['hg', 'sl']) {
    await writeFile(join(bin, tool), FAKE)
    await chmod(join(bin, tool), 0o755)
  }
  root = join(base, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  log = join(base, 'calls.log')
  // Git finds no repository above the temp directory.
  Object.assign(process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    PROVINO_FAKE_LOG: log,
    PROVINO_FAKE_ROOT: root,
    GIT_CEILING_DIRECTORIES: base,
  })
  delete process.env.HGPLAIN
  real = createRequire(core)('jest-changed-files') as RealChangedFiles
})

afterAll(async () => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
  Object.assign(process.env, saved)
  await rm(base, { recursive: true, force: true })
})

async function calls(): Promise<string[]> {
  const text = await readFile(log, 'utf8').catch(() => '')
  await writeFile(log, '')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .sort()
}

async function same(roots: string[], options: Omit<ChangedFilesOptions, 'roots'>) {
  await writeFile(log, '')
  const expected = await real.getChangedFilesForRoots(roots, { ...options })
  const expectedCalls = await calls()
  const got = await jestChangedFiles({ roots, ...options })
  const gotCalls = await calls()
  assert.deepEqual(gotCalls, expectedCalls)
  assert.deepEqual([...got.changedFiles].sort(), [...expected.changedFiles].sort())
  for (const kind of ['git', 'hg', 'sl'] as const) {
    assert.deepEqual([...got.repos[kind]].sort(), [...expected.repos[kind]].sort(), kind)
  }
  return { got, calls: gotCalls }
}

const OPTIONS: readonly (readonly [string, Omit<ChangedFilesOptions, 'roots'>])[] = [
  ['uncommitted', {}],
  ['--lastCommit', { lastCommit: true }],
  ['--changedSince', { changedSince: 'main' }],
  ['--changedFilesWithAncestor', { withAncestor: true }],
  ['--changedSince with --lastCommit', { changedSince: 'main', lastCommit: true }],
]

for (const [name, options] of OPTIONS) {
  test(`hg and sl get Jest's arguments: ${name}`, async () => {
    const { got, calls: made } = await same([root, join(root, 'src')], options)
    assert.ok(made.some((line) => line.startsWith('hg|') && line.includes('|1|status')))
    assert.ok(made.some((line) => line.startsWith('sl|') && line.includes('|1|status')))
    assert.deepEqual(got.repos.hg, [root])
    assert.deepEqual(got.repos.sl, [root])
    assert.deepEqual([...got.changedFiles].sort(), [join(root, 'a.ts'), join(root, 'src/b.ts')])
  })
}

// Last: jest-changed-files remembers the locomotive for the rest of the process.
test('an sl that is the steam locomotive is no Sapling root', async () => {
  process.env.PROVINO_FAKE_LOCOMOTIVE = '1'
  try {
    const { got } = await same([root], {})
    assert.deepEqual(got.repos.sl, [])
    assert.deepEqual(got.repos.hg, [root])
  } finally {
    delete process.env.PROVINO_FAKE_LOCOMOTIVE
  }
})
