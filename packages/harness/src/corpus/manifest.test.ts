// T12.9: the committed manifest pins all 33 F5 repositories, and the parser refuses what the brief
// says it refuses. No network: the pins' truth is `corpus pin` and `corpus fetch --verify-only`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import {
  type CorpusManifest,
  PROVINO_REFUSED_FLAGS,
  parseCorpusManifest,
  R6_REPO_IDS,
  readCorpusManifest,
  selectRepos,
  selectSubjects,
} from './manifest.ts'

const PILOT = [
  'react-hook-form',
  'mobx',
  'styled-components',
  'swr',
  'jest-extended',
  'tanstack-query',
  'nest',
  'zustand',
]

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }
type Draft = Mutable<CorpusManifest>

function rejects(text: string, pattern: RegExp): void {
  assert.throws(
    () => parseCorpusManifest(text, 'manifest.json'),
    (error) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_CORPUS_MANIFEST_INVALID' &&
      pattern.test(error.message),
  )
}

/** The committed manifest, changed by `change` on a copy, as text. */
async function edited(change: (draft: Draft) => void): Promise<string> {
  const draft = structuredClone(await readCorpusManifest()) as Draft
  change(draft)
  return JSON.stringify(draft)
}

function repoOf(draft: Draft, id: string): Draft['repos'][number] {
  const repo = draft.repos.find((candidate) => candidate.id === id)
  if (repo === undefined) throw new Error(`no ${id} in the manifest`)
  return repo
}

function subjectOf(draft: Draft, id: string): Draft['repos'][number]['subjects'][number] {
  const subject = repoOf(draft, id).subjects[0]
  if (subject === undefined) throw new Error(`${id} has no subject`)
  return subject
}

test('the manifest pins all 33 F5 repositories, each with a full SHA and a tarball hash', async () => {
  const manifest = await readCorpusManifest()
  assert.equal(manifest.repos.length, 33)
  for (const repo of manifest.repos) {
    assert.match(repo.sha, /^[0-9a-f]{40}$/, repo.id)
    assert.ok(repo.sha.startsWith(repo.f5Sha), repo.id)
    assert.match(repo.tarballSha256, /^[0-9a-f]{64}$/, repo.id)
    assert.equal(repo.licence, 'MIT', repo.id)
    assert.ok(repo.subjects.length > 0, repo.id)
  }
  assert.equal(new Set(manifest.repos.map((repo) => repo.id)).size, 33)
  const subjects = manifest.repos.flatMap((repo) => repo.subjects.map((subject) => subject.id))
  assert.equal(new Set(subjects).size, subjects.length, 'subject ids are unique')
})

test('the pilot is the 8 repositories D4 and D40 name', async () => {
  const manifest = await readCorpusManifest()
  assert.deepEqual(
    selectRepos(manifest, { kind: 'pilot' })
      .map((repo) => repo.id)
      .toSorted(),
    PILOT.toSorted(),
  )
})

test('R6 measures the 5 Jest repositories, each by exactly one subject, styled-components on main', async () => {
  const manifest = await readCorpusManifest()
  const measured = manifest.repos.filter((repo) => repo.subjects.some((subject) => subject.r6))
  assert.deepEqual(measured.map((repo) => repo.id).toSorted(), R6_REPO_IDS.toSorted())
  for (const repo of measured) {
    assert.equal(repo.subjects.filter((subject) => subject.r6).length, 1, repo.id)
    assert.ok(
      repo.subjects.every((subject) => subject.runner === 'jest'),
      `${repo.id} is a Jest repository`,
    )
  }
  const styled = manifest.repos.find((repo) => repo.id === 'styled-components')
  assert.deepEqual(
    styled?.subjects.map((subject) => [subject.id, subject.r6]),
    [
      ['styled-components', true],
      ['styled-components-native', false],
    ],
  )
  assert.ok(styled?.subjects[1]?.argv.includes('--forceExit'))
  assert.equal(styled?.subjects[1]?.provinoRefuses?.[0]?.flag, '--forceExit')
})

test('every flag provino jest refuses is listed on the subject that uses it', async () => {
  const manifest = await readCorpusManifest()
  for (const repo of manifest.repos) {
    for (const subject of repo.subjects) {
      const listed = (subject.provinoRefuses ?? []).map((entry) => entry.flag)
      for (const arg of subject.argv) {
        if (PROVINO_REFUSED_FLAGS.includes(arg)) {
          assert.ok(listed.includes(arg), `${subject.id} ${arg}`)
        }
      }
    }
  }
})

test('the pilot repositories commit a lockfile their own package manager can freeze', async () => {
  const manifest = await readCorpusManifest()
  for (const repo of selectRepos(manifest, { kind: 'pilot' })) {
    assert.ok(repo.install.lockfile, repo.id)
  }
  const names = Object.fromEntries(manifest.repos.map((repo) => [repo.id, repo.install.name]))
  assert.equal(names['jest-extended'], 'yarn')
  assert.equal(names.mobx, 'npm')
  assert.equal(names.nest, 'npm')
  assert.equal(names.swr, 'pnpm')
})

test('a repository id selects all its subjects, a subject id only itself', async () => {
  const manifest = await readCorpusManifest()
  assert.deepEqual(
    selectSubjects(manifest, { kind: 'ids', ids: ['styled-components'] }).map((s) => s.subject.id),
    ['styled-components', 'styled-components-native'],
  )
  assert.deepEqual(
    selectSubjects(manifest, { kind: 'ids', ids: ['styled-components-native'] }).map(
      (s) => s.subject.id,
    ),
    ['styled-components-native'],
  )
  assert.throws(() => selectRepos(manifest, { kind: 'ids', ids: ['nope'] }), /no corpus repository/)
})

test('the parser refuses a short SHA, a non-MIT licence and a duplicate id', async () => {
  rejects(
    await edited((draft) => {
      const repo = repoOf(draft, 'jest')
      repo.sha = repo.sha.slice(0, 7)
    }),
    /full 40-character/,
  )
  rejects(
    await edited((draft) => {
      repoOf(draft, 'jest').licence = 'GPL' as 'MIT'
    }),
    /MIT/,
  )
  rejects(
    await edited((draft) => {
      repoOf(draft, 'react').id = 'jest'
    }),
    /two repositories with id/,
  )
  rejects(
    await edited((draft) => {
      repoOf(draft, 'jest').sha = '0'.repeat(40)
    }),
    /does not start with F5's/,
  )
})

test('the parser refuses an argv the harness cannot use', async () => {
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'swr').argv = []
    }),
    /must have --ci/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'swr').argv.push('--json')
    }),
    /--json/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'swr').argv.push('--bail')
    }),
    /must list --bail/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'zustand').argv = ['--silent']
    }),
    /--silent/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'zustand').argv = ['--reporter=dot']
    }),
    /--reporter/,
  )
})

test('the parser refuses an r6 flag outside the five, or a missing one', async () => {
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'nest').r6 = true
    }),
    /not one of R6's 5/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'swr').r6 = false
    }),
    /exactly one subject with r6/,
  )
})

test('the parser refuses a path that leaves the repository', async () => {
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'swr').cwd = '../elsewhere'
    }),
    /relative POSIX path/,
  )
  rejects(
    await edited((draft) => {
      repoOf(draft, 'swr').install.lockfile = '/etc/passwd'
    }),
    /relative POSIX path/,
  )
})

test('an unknown key is refused, so a typo cannot silently drop a field', async () => {
  const draft = structuredClone(await readCorpusManifest()) as Draft
  const typo = { ...repoOf(draft, 'swr'), subjectz: [] }
  const text = JSON.stringify({
    ...draft,
    repos: draft.repos.map((repo) => (repo.id === 'swr' ? typo : repo)),
  })
  rejects(text, /unknown key "subjectz"/)
})
