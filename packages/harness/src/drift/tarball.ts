// A repository's tree at a tag, for the drift report: the tag's tarball from codeload, saved and
// extracted once under the cache directory (`PROVINO_DRIFT_DIR`, else `<tmp>/provino-drift`), as
// `.refs` is filled (a tarball, never a clone). The download is the corpus fetcher's (retries, a
// timeout, a partial file never kept).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDeps } from '../corpus/deps.ts'
import { download, tarballUrl } from '../corpus/fetch.ts'
import { REPOSITORIES, type Repository } from './upstream.ts'

/** Where the tarballs and trees are kept. */
export function driftCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROVINO_DRIFT_DIR ?? join(tmpdir(), 'provino-drift')
}

/** A tag name a URL and a directory can hold. */
const TAG = /^[\w.+-]+$/

/**
 * The extracted tree of `repository` at `tag`: downloaded with `curl` and unpacked with `tar` the
 * first time, then reused.
 */
export async function treeAt(
  repository: Repository,
  tag: string,
  cache: string = driftCacheDir(),
): Promise<string> {
  if (!TAG.test(tag)) throw new Error(`drift: not a tag name: ${tag}`)
  const tree = join(cache, `${repository}-${tag}`)
  if (existsSync(tree)) return tree
  const archive = join(cache, `${repository}-${tag}.tar.gz`)
  if (!existsSync(archive)) {
    const url = tarballUrl({ repo: REPOSITORIES[repository], sha: `refs/tags/${tag}` })
    await download(url, archive, defaultDeps, process.env)
  }
  const partialTree = `${tree}.part`
  rmSync(partialTree, { recursive: true, force: true })
  mkdirSync(partialTree, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', partialTree, '--strip-components=1'])
  renameSync(partialTree, tree)
  return tree
}
