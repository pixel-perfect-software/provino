// T12.9: the committed manifest pins all 33 F5 repositories, and the parser refuses what the brief
// says it refuses. No network: the pins' truth is `corpus pin` and `corpus fetch --verify-only`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import {
  type CorpusManifest,
  parseCorpusManifest,
  readCorpusManifest,
  selectRepos,
  selectSubjects,
} from './manifest.ts'

const R6_REPO_IDS = ['jest-extended', 'react-hook-form', 'mobx', 'swr', 'styled-components']

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

test('a repository run through nx, turbo or lerna has one subject per package its script covers (D56: no cap)', async () => {
  const manifest = await readCorpusManifest()
  const counts = (id: string) => {
    const repo = manifest.repos.find((candidate) => candidate.id === id)
    if (repo === undefined) throw new Error(`no repo ${id}`)
    return {
      vitest: repo.subjects.filter((subject) => subject.runner === 'vitest').length,
      jest: repo.subjects.filter((subject) => subject.runner === 'jest').length,
    }
  }
  assert.deepEqual(counts('nx'), { vitest: 41, jest: 9 })
  // test:lib in 26 packages (vue-query runs it once, as Vue 3).
  assert.deepEqual(counts('tanstack-query'), { vitest: 26, jest: 0 })
  assert.deepEqual(counts('typescript-eslint'), { vitest: 14, jest: 0 })
  for (const repo of manifest.repos) {
    for (const skipped of repo.skipped ?? []) {
      assert.doesNotMatch(
        skipped.reason,
        /\bcap(ped|s)?\b|more packages/,
        `${repo.id}: ${skipped.path}`,
      )
    }
  }
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

test('every package manager is pinned to an exact version, so no install falls back to a default', async () => {
  const manifest = await readCorpusManifest()
  for (const repo of manifest.repos) assert.match(repo.install.version, /^\d+\.\d+\.\d+$/, repo.id)
  rejects(
    await edited((draft) => {
      delete (repoOf(draft, 'mobx').install as { version?: string }).version
    }),
    /install\.version must be a non-empty string/,
  )
  rejects(
    await edited((draft) => {
      repoOf(draft, 'mobx').install.version = 'latest'
    }),
    /install\.version must be the package manager's exact version/,
  )
})

test('provinoRefuses is what provino jest itself refuses on the subject, by the parser', async () => {
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'mobx').argv.push('--coverage')
    }),
    /must list --coverage: provino jest refuses it/,
  )
  // A flag is named as the parser names it, with its value split off.
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'mobx').argv.push('--shard=1/2')
    }),
    /must list --shard:/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'mobx').argv.push('--maxWorkers=2')
      subjectOf(draft, 'mobx').provinoRefuses = [{ flag: '--maxWorkers', reason: 'it is read' }]
    }),
    /lists --maxWorkers, which provino jest does not refuse for this argv/,
  )
  const accepted = await edited((draft) => {
    const subject = subjectOf(draft, 'mobx')
    subject.argv.push('--coverage')
    subject.provinoRefuses = [{ flag: '--coverage', reason: 'no coverage backend yet' }]
  })
  assert.doesNotThrow(() => parseCorpusManifest(accepted, 'manifest.json'))
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

test('the parser wants exactly 5 repositories with an r6 subject, one subject each', async () => {
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'nest').r6 = true
    }),
    /exactly 5 repositories with an r6 subject.*has 6/,
  )
  rejects(
    await edited((draft) => {
      subjectOf(draft, 'swr').r6 = false
    }),
    /exactly 5 repositories with an r6 subject.*has 4/,
  )
  rejects(
    await edited((draft) => {
      const second = repoOf(draft, 'styled-components').subjects[1]
      if (second === undefined) throw new Error('no second subject')
      second.r6 = true
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
