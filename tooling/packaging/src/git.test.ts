// The base a hygiene run measures against is where this branch left its base branch (the merge
// base), not the base branch's tip: on a stacked branch whose parent moved, the tip holds other
// PRs' API reports and changesets, which would be blamed on this one.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { changesetsSince } from './changesets.ts'
import { fileAt, newFilesSince, resolveBase } from './git.ts'
import { type Repository, repository, writeFiles } from './test-support.ts'

describe('the base is the merge base (T1.6)', () => {
  // One repository for the cases, built once; none of them changes it but the orphan one, which
  // adds a branch and comes back.
  //
  // main: A -> B (another PR: a new report, and a release that consumed old.md)
  //        \
  // feature: A -> C (this branch: a changeset of its own)
  let repo: Repository
  let branchPoint = ''
  let tip = ''
  before(() => {
    repo = repository({
      'etc/x.api.md': 'report v1\n',
      '.changeset/old.md': '---\n"provino": patch\n---\n',
      '.changeset/config.json': '{}',
    })
    const { dir, git } = repo
    git('add', '.')
    git('commit', '-q', '-m', 'A')
    branchPoint = git('rev-parse', 'HEAD')
    git('switch', '-q', '-c', 'feature')
    writeFiles(dir, { '.changeset/mine.md': '---\n"@provino/types": minor\n---\n' })
    git('add', '.')
    git('commit', '-q', '-m', 'C')
    git('switch', '-q', 'main')
    writeFiles(dir, {
      'etc/x.api.md': 'report v2, from another PR\n',
      '.changeset/theirs.md': '---\n"provino": minor\n---\n',
    })
    rmSync(join(dir, '.changeset/old.md'))
    git('add', '-A')
    git('commit', '-q', '-m', 'B')
    tip = git('rev-parse', 'HEAD')
    git('switch', '-q', 'feature')
  })

  test('resolves to where the branch left its base, not to the base branch tip', () => {
    assert.notEqual(branchPoint, tip)
    assert.equal(resolveBase(repo.dir, 'main'), branchPoint)
  })

  test("a report is read as it was at the branch point, so another PR's change is not this branch's", () => {
    assert.equal(fileAt(repo.dir, resolveBase(repo.dir, 'main'), 'etc/x.api.md'), 'report v1\n')
  })

  test("a changeset the base branch consumed is not counted as added here, and another PR's is not missed", () => {
    const base = resolveBase(repo.dir, 'main')
    assert.deepEqual(newFilesSince(repo.dir, base, '.changeset'), ['.changeset/mine.md'])
    assert.deepEqual(
      changesetsSince(repo.dir, base).map((changeset) => changeset.file),
      ['.changeset/mine.md'],
    )
  })

  test('a ref that is a commit before the branch point, or the branch itself, resolves to itself', () => {
    assert.equal(resolveBase(repo.dir, branchPoint), branchPoint)
    assert.equal(resolveBase(repo.dir, 'feature'), repo.git('rev-parse', 'feature'))
  })

  test('a ref with no common history fails, naming it', () => {
    const { dir, git } = repo
    git('switch', '-q', '--orphan', 'unrelated')
    writeFiles(dir, { 'readme.md': 'x\n' })
    git('add', 'readme.md')
    git('commit', '-q', '-m', 'orphan')
    git('switch', '-q', 'feature')
    assert.throws(() => resolveBase(dir, 'unrelated'), /no common history with HEAD/)
  })

  test('an unknown ref fails, as before', () => {
    assert.throws(
      () => resolveBase(repo.dir, 'origin/nope'),
      /cannot resolve the base "origin\/nope"/,
    )
  })
})
