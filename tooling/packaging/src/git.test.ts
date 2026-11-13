// The base a hygiene run measures against is where this branch left its base branch (the merge
// base), not the base branch's tip: on a stacked branch whose parent moved, the tip holds other
// PRs' API reports and changesets, which would be blamed on this one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { changesetsSince } from './changesets.ts'
import { fileAt, newFilesSince, resolveBase } from './git.ts'

/** A temp repository, and the git command in it (unsigned, with a committer). */
function repository(): { readonly dir: string; readonly git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'git-base-'))
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd: dir, encoding: 'utf8' },
    ).trim()
  git('init', '-q', '--initial-branch=main')
  return { dir, git }
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

describe('the base is the merge base (T1.6)', () => {
  // main: A -> B (another PR: a new report, and a release that consumed old.md)
  //        \
  // feature: A -> C (this branch: a changeset of its own)
  function stacked() {
    const { dir, git } = repository()
    write(dir, 'etc/x.api.md', 'report v1\n')
    write(dir, '.changeset/old.md', '---\n"provino": patch\n---\n')
    write(dir, '.changeset/config.json', '{}')
    git('add', '.')
    git('commit', '-q', '-m', 'A')
    const branchPoint = git('rev-parse', 'HEAD')
    git('switch', '-q', '-c', 'feature')
    write(dir, '.changeset/mine.md', '---\n"@provino/types": minor\n---\n')
    git('add', '.')
    git('commit', '-q', '-m', 'C')
    git('switch', '-q', 'main')
    write(dir, 'etc/x.api.md', 'report v2, from another PR\n')
    rmSync(join(dir, '.changeset/old.md'))
    write(dir, '.changeset/theirs.md', '---\n"provino": minor\n---\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'B')
    const tip = git('rev-parse', 'HEAD')
    git('switch', '-q', 'feature')
    return { dir, git, branchPoint, tip }
  }

  test('resolves to where the branch left its base, not to the base branch tip', () => {
    const { dir, branchPoint, tip } = stacked()
    assert.notEqual(branchPoint, tip)
    assert.equal(resolveBase(dir, 'main'), branchPoint)
  })

  test("a report is read as it was at the branch point, so another PR's change is not this branch's", () => {
    const { dir } = stacked()
    assert.equal(fileAt(dir, resolveBase(dir, 'main'), 'etc/x.api.md'), 'report v1\n')
  })

  test("a changeset the base branch consumed is not counted as added here, and another PR's is not missed", () => {
    const { dir } = stacked()
    const base = resolveBase(dir, 'main')
    assert.deepEqual(newFilesSince(dir, base, '.changeset'), ['.changeset/mine.md'])
    assert.deepEqual(
      changesetsSince(dir, base).map((changeset) => changeset.file),
      ['.changeset/mine.md'],
    )
  })

  test('a ref that is a commit before the branch point, or the branch itself, resolves to itself', () => {
    const { dir, git, branchPoint } = stacked()
    assert.equal(resolveBase(dir, branchPoint), branchPoint)
    assert.equal(resolveBase(dir, 'feature'), git('rev-parse', 'feature'))
  })

  test('a ref with no common history fails, naming it', () => {
    const { dir, git } = stacked()
    git('switch', '-q', '--orphan', 'unrelated')
    write(dir, 'readme.md', 'x\n')
    git('add', 'readme.md')
    git('commit', '-q', '-m', 'orphan')
    git('switch', '-q', 'feature')
    assert.throws(() => resolveBase(dir, 'unrelated'), /no common history with HEAD/)
  })

  test('an unknown ref fails, as before', () => {
    const { dir } = stacked()
    assert.throws(() => resolveBase(dir, 'origin/nope'), /cannot resolve the base "origin\/nope"/)
  })
})
