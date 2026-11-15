// jest-changed-files 30.5.1 `src/index.ts`: the repositories of every root (git, hg and sl, at most
// five root lookups at once), then each repository's changed files under the roots. No p-limit:
// the limiter is the few lines below (D115).
import type { ChangedFiles, ChangedFilesOptions } from '@provino/types'
import { gitAdapter, hgAdapter, type ScmAdapter, slAdapter } from './scm.ts'

/** `index.ts` L18-L20: at most `limit` calls of `run` at once (`pLimit(5)`). */
export function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  const next = (): void => {
    if (active >= limit) return
    const start = waiting.shift()
    if (start === undefined) return
    active++
    start()
  }
  return (run) =>
    new Promise((resolvePromise, reject) => {
      waiting.push(() => {
        run()
          .then(resolvePromise, reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
}

/** The repositories of some roots, by kind, as sets (`findRepos`, `index.ts` L62-L74). */
async function findRepos(
  roots: readonly string[],
  adapters: { readonly git: ScmAdapter; readonly hg: ScmAdapter; readonly sl: ScmAdapter },
): Promise<{ git: Set<string>; hg: Set<string>; sl: Set<string> }> {
  const mutex = createLimiter(5)
  const find = (adapter: ScmAdapter): Promise<(string | null)[]> =>
    Promise.all(roots.map((root) => mutex(() => adapter.getRoot(root))))
  const [git, hg, sl] = await Promise.all([
    find(adapters.git),
    find(adapters.hg),
    find(adapters.sl),
  ])
  const present = (list: readonly (string | null)[]): Set<string> =>
    new Set(list.filter((repo): repo is string => repo !== null))
  return { git: present(git), hg: present(hg), sl: present(sl) }
}

/**
 * A changed-files provider and the adapters it keeps: what Jest keeps per process (whether `sl` is
 * the steam locomotive) lives as long as the provider does.
 */
export function createChangedFilesProvider(): (
  options: ChangedFilesOptions,
) => Promise<ChangedFiles> {
  const adapters = { git: gitAdapter, hg: hgAdapter, sl: slAdapter() }
  return (options) => changedFilesForRoots(options, adapters)
}

/**
 * `getChangedFilesForRoots` (`index.ts` L26-L60): every changed file of every repository the roots
 * are in, with the roots as `includePaths`. A failing command rejects with execa's message.
 */
async function changedFilesForRoots(
  options: ChangedFilesOptions,
  adapters: { readonly git: ScmAdapter; readonly hg: ScmAdapter; readonly sl: ScmAdapter },
): Promise<ChangedFiles> {
  const { roots } = options
  const repos = await findRepos(roots, adapters)
  const changedFilesOptions = {
    includePaths: roots,
    changedSince: options.changedSince,
    lastCommit: options.lastCommit,
    withAncestor: options.withAncestor,
  }
  const all = await Promise.all([
    ...Array.from(repos.git, (repo) => adapters.git.findChangedFiles(repo, changedFilesOptions)),
    ...Array.from(repos.hg, (repo) => adapters.hg.findChangedFiles(repo, changedFilesOptions)),
    ...Array.from(repos.sl, (repo) => adapters.sl.findChangedFiles(repo, changedFilesOptions)),
  ])
  const changedFiles = new Set<string>()
  for (const files of all) for (const file of files) changedFiles.add(file)
  return {
    changedFiles: [...changedFiles],
    repos: { git: [...repos.git], hg: [...repos.hg], sl: [...repos.sl] },
  }
}
